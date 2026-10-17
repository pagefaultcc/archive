package store

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// ArchiveSearchResult represents one entry found across all archives.
type ArchiveSearchResult struct {
	ID              int64      `json:"id"`
	ArchiveID       string     `json:"archiveId"`
	ArchiveFilename string     `json:"archiveFilename"`
	Path            string     `json:"path"`
	Name            string     `json:"name"`
	SizeBytes       int64      `json:"sizeBytes"`
	PackedBytes     int64      `json:"packedBytes"`
	CRC32           string     `json:"crc32"`
	Encrypted       bool       `json:"encrypted"`
	ModifiedAt      *time.Time `json:"modifiedAt"`
}

// SearchFilters holds multi-dimensional search parameters.
type SearchFilters struct {
	Query        string // Global text or regex
	FileName     string // Specific file name substring or regex
	FileType     string // Extension (e.g. "txt", "pdf", "json", "docx")
	MinSizeBytes int64  // Minimum size in bytes
	MaxSizeBytes int64  // Maximum size in bytes
	ArchiveID    string // Specific archive filter
	IsRegex      bool   // Treat strings as POSIX regex
	IsExact      bool   // Exact filename match
	Limit        int
	Offset       int
}

// detectQueryMode automatically determines whether a search string should be treated as
// an exact filename match, a POSIX regular expression, or a standard substring search.
func detectQueryMode(raw string) (cleaned string, mode string) {
	s := strings.TrimSpace(raw)
	// 1. Quoted string (e.g. "auth.json" or 'passwords.txt') -> exact match
	if (strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`)) ||
		(strings.HasPrefix(s, `'`) && strings.HasSuffix(s, `'`)) {
		if len(s) >= 2 {
			return s[1 : len(s)-1], "exact"
		}
	}
	// 2. Contains POSIX regex metacharacters (excluding lone dot in filenames) -> regex mode
	if strings.ContainsAny(s, `^$*+?()[]{}|\\`) {
		return s, "regex"
	}
	// 3. Default: substring (including domain/filename queries like openai.com or passwords.txt)
	return s, "substring"
}

// SearchArchiveEntries executes a blazingly fast trigram/GIN indexed search across all archives.
func (s *Store) SearchArchiveEntries(ctx context.Context, f SearchFilters) ([]ArchiveSearchResult, int64, error) {
	if f.Limit <= 0 || f.Limit > 10000 {
		f.Limit = 100
	}
	if f.Offset < 0 {
		f.Offset = 0
	}

	// Instant fast-path for blank initial load: avoids 15-second disk sort across 6.3M rows
	if f.Query == "" && f.FileName == "" && f.FileType == "" && f.MinSizeBytes == 0 && f.MaxSizeBytes == 0 && f.ArchiveID == "" {
		var countTotal int64
		err := s.pool.QueryRow(ctx, `SELECT reltuples::bigint FROM pg_class WHERE relname = 'archive_entries'`).Scan(&countTotal)
		if err != nil || countTotal <= 0 {
			if err := s.pool.QueryRow(ctx, `
				SELECT count(*)
				FROM archive_entries e
				JOIN archives a ON a.id = e.archive_id
				WHERE e.is_dir = false AND a.status = 'indexed'
			`).Scan(&countTotal); err != nil {
				return nil, 0, fmt.Errorf("counting archive entries: %w", err)
			}
		}

		rows, err := s.pool.Query(ctx, `
			SELECT e.id, e.archive_id, a.filename, e.path, e.name, 
			       e.size_bytes, e.packed_bytes, e.crc32, e.encrypted, e.modified_at
			FROM archive_entries e
			JOIN archives a ON a.id = e.archive_id
			WHERE e.is_dir = false AND a.status = 'indexed'
			ORDER BY e.id DESC
			LIMIT $1 OFFSET $2;
		`, f.Limit, f.Offset)
		if err != nil {
			return nil, 0, fmt.Errorf("searching archive entries: %w", err)
		}
		defer rows.Close()

		var results []ArchiveSearchResult
		for rows.Next() {
			var r ArchiveSearchResult
			if err := rows.Scan(
				&r.ID, &r.ArchiveID, &r.ArchiveFilename, &r.Path, &r.Name,
				&r.SizeBytes, &r.PackedBytes, &r.CRC32, &r.Encrypted, &r.ModifiedAt,
			); err != nil {
				return nil, 0, err
			}
			results = append(results, r)
		}
		if results == nil {
			results = []ArchiveSearchResult{}
		}
		return results, countTotal, rows.Err()
	}

	whereClauses := []string{"e.is_dir = false", "a.status = 'indexed'"}
	args := []any{}
	argID := 1
	addCond := func(clause string, val any) {
		whereClauses = append(whereClauses, fmt.Sprintf(clause, argID))
		args = append(args, val)
		argID++
	}

	if f.ArchiveID != "" {
		addCond("e.archive_id = $%d", f.ArchiveID)
	}
	if f.FileType != "" {
		cleanExt := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(f.FileType)), ".")
		addCond("lower(e.name) LIKE '%%.' || $%d", cleanExt)
	}
	if f.MinSizeBytes > 0 {
		addCond("e.size_bytes >= $%d", f.MinSizeBytes)
	}
	if f.MaxSizeBytes > 0 {
		addCond("e.size_bytes <= $%d", f.MaxSizeBytes)
	}

	if f.FileName != "" {
		fn, mode := detectQueryMode(f.FileName)
		if f.IsExact || mode == "exact" {
			addCond("lower(e.name) = lower($%d)", fn)
		} else if f.IsRegex || mode == "regex" {
			addCond("e.name ~* $%d", fn)
		} else {
			escapedFn := escapeLike(fn)
			addCond("lower(e.name) LIKE '%%' || lower($%d) || '%%' ESCAPE '\\'", escapedFn)
		}
	}

	if f.Query != "" {
		q, mode := detectQueryMode(f.Query)
		if f.IsExact || mode == "exact" {
			addCond("lower(e.name) = lower($%d)", q)
		} else if f.IsRegex || mode == "regex" {
			clause := fmt.Sprintf("(e.name ~* $%d OR e.path ~* $%d)", argID, argID+1)
			whereClauses = append(whereClauses, clause)
			args = append(args, q, q)
			argID += 2
		} else {
			escapedQ := escapeLike(q)
			clause := fmt.Sprintf("(lower(e.name) LIKE '%%' || lower($%d) || '%%' ESCAPE '\\' OR lower(e.path) LIKE '%%' || lower($%d) || '%%' ESCAPE '\\')", argID, argID+1)
			whereClauses = append(whereClauses, clause)
			args = append(args, escapedQ, escapedQ)
			argID += 2
		}
	}

	whereSQL := strings.Join(whereClauses, " AND ")

	// Get count (capped timeout/estimate for instant response)
	var countTotal int64
	countSQL := fmt.Sprintf("SELECT count(*) FROM archive_entries e JOIN archives a ON a.id = e.archive_id WHERE %s", whereSQL)
	cctx, ccancel := context.WithTimeout(ctx, 3*time.Second)
	_ = s.pool.QueryRow(cctx, countSQL, args...).Scan(&countTotal)
	ccancel()

	// Query search results
	querySQL := fmt.Sprintf(`
		SELECT e.id, e.archive_id, a.filename, e.path, e.name, 
		       e.size_bytes, e.packed_bytes, e.crc32, e.encrypted, e.modified_at
		FROM archive_entries e
		JOIN archives a ON a.id = e.archive_id
		WHERE %s
		ORDER BY e.size_bytes DESC, e.id DESC
		LIMIT $%d OFFSET $%d
	`, whereSQL, argID, argID+1)

	args = append(args, f.Limit, f.Offset)

	rows, err := s.pool.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("searching archive entries: %w", err)
	}
	defer rows.Close()

	var results []ArchiveSearchResult
	for rows.Next() {
		var r ArchiveSearchResult
		if err := rows.Scan(
			&r.ID, &r.ArchiveID, &r.ArchiveFilename, &r.Path, &r.Name,
			&r.SizeBytes, &r.PackedBytes, &r.CRC32, &r.Encrypted, &r.ModifiedAt,
		); err != nil {
			return nil, 0, err
		}
		results = append(results, r)
	}
	if results == nil {
		results = []ArchiveSearchResult{}
	}
	if countTotal == 0 && len(results) > 0 {
		countTotal = int64(len(results))
	}
	return results, countTotal, rows.Err()
}
