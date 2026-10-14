package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// ArchiveItem is the JSON contract for one archive row.
type ArchiveItem struct {
	ID                string    `json:"id"`
	OwnerID           string    `json:"ownerId"`
	OwnerUsername     string    `json:"ownerUsername"`
	Filename          string    `json:"filename"`
	Format            string    `json:"format"`
	SizeBytes         int64     `json:"sizeBytes"`
	SHA256            string    `json:"sha256"`
	IsEncrypted       bool      `json:"isEncrypted"`
	Status            string    `json:"status"`
	FileCount         int       `json:"fileCount"`
	DirCount          int       `json:"dirCount"`
	UncompressedBytes int64     `json:"uncompressedBytes"`
	CreatedAt         time.Time `json:"createdAt"`
}

// ArchiveEntry is the JSON contract for one indexed archive member.
type ArchiveEntry struct {
	ID          int64      `json:"id"`
	Path        string     `json:"path"`
	ParentPath  string     `json:"parentPath"`
	Name        string     `json:"name"`
	IsDir       bool       `json:"isDir"`
	SizeBytes   int64      `json:"sizeBytes"`
	PackedBytes int64      `json:"packedBytes"`
	CRC32       string     `json:"crc32"`
	Encrypted   bool       `json:"encrypted"`
	ModifiedAt  *time.Time `json:"modifiedAt"`
}

// ArchiveDetail is the JSON contract for GET /api/archives/{id}.
type ArchiveDetail struct {
	Archive    ArchiveItem    `json:"archive"`
	Entries    []ArchiveEntry `json:"entries"`
	ParentPath string         `json:"parentPath"`
	Query      string         `json:"query"`
}

// IndexStats is the entry-count summary produced by indexing.
type IndexStats struct {
	FileCount         int
	DirCount          int
	UncompressedBytes int64
}

// EntryInput is the exported handle for handlers to insert entries.
type EntryInput = archiveEntryInput

// Stats summarizes indexed entries.
func (r IndexStats) Entries() int { return r.FileCount + r.DirCount }

// archiveEntryInput is one parsed entry to persist.
type archiveEntryInput struct {
	Path        string
	ParentPath  string
	Name        string
	IsDir       bool
	SizeBytes   int64
	PackedBytes int64
	CRC32       string
	Encrypted   bool
	ModifiedAt  *time.Time
}

// CreateArchiveInput carries everything needed to insert one archive.
type CreateArchiveInput struct {
	OwnerID         string
	Filename        string
	Format          string
	SizeBytes       int64
	SHA256          string
	IsEncrypted     bool
	ArchivePassword string
	Status          string
	StoragePath     string
	Entries         []archiveEntryInput
}

// NewEntryStats counts files, dirs, and total uncompressed size.
func NewEntryStats(entries []archiveEntryInput) IndexStats {
	var s IndexStats
	for _, e := range entries {
		if e.IsDir {
			s.DirCount++
			continue
		}
		s.FileCount++
		s.UncompressedBytes += e.SizeBytes
	}
	return s
}

// CreateArchive inserts an archives row plus all archive_entries rows and the
// archive.uploaded audit row in one transaction.
func (s *Store) CreateArchive(ctx context.Context, in CreateArchiveInput) (ArchiveItem, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("beginning archive insert: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	in.ArchivePassword = strings.Trim(strings.TrimSpace(in.ArchivePassword), "`'\"")
	stats := NewEntryStats(in.Entries)
	var id string
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO archives
			(owner_id, filename, format, size_bytes, sha256, is_encrypted, archive_password, status,
			 file_count, dir_count, uncompressed_bytes, storage_path)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		RETURNING id::text, created_at
	`, in.OwnerID, in.Filename, in.Format, in.SizeBytes, in.SHA256, in.IsEncrypted,
		in.ArchivePassword, in.Status, stats.FileCount, stats.DirCount,
		stats.UncompressedBytes, in.StoragePath).Scan(&id, &createdAt)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("inserting archive: %w", err)
	}

	if len(in.Entries) > 0 {
		if _, err := tx.CopyFrom(ctx,
			pgx.Identifier{"archive_entries"},
			[]string{"archive_id", "path", "parent_path", "name", "is_dir",
				"size_bytes", "packed_bytes", "crc32", "encrypted", "modified_at"},
			pgx.CopyFromSlice(len(in.Entries), func(i int) ([]any, error) {
				e := in.Entries[i]
				return []any{id, e.Path, e.ParentPath, e.Name, e.IsDir,
					e.SizeBytes, e.PackedBytes, e.CRC32, e.Encrypted, e.ModifiedAt}, nil
			})); err != nil {
			return ArchiveItem{}, fmt.Errorf("inserting archive entries: %w", err)
		}
	}

	if err := txAudit(ctx, tx, in.OwnerID, "archive.uploaded", "archive", id,
		map[string]any{"filename": in.Filename, "format": in.Format,
			"status": in.Status, "size_bytes": in.SizeBytes}); err != nil {
		return ArchiveItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ArchiveItem{}, fmt.Errorf("committing archive insert: %w", err)
	}
	return s.GetArchive(ctx, id)
}

// GetArchive loads one archive item by ID.
func (s *Store) GetArchive(ctx context.Context, id string) (ArchiveItem, error) {
	row := s.pool.QueryRow(ctx, archiveSelect+` WHERE a.id = $1`, id)
	return scanArchive(row)
}

// GetArchiveBySHA256 checks if an archive with the exact same hash already exists.
func (s *Store) GetArchiveBySHA256(ctx context.Context, sha string) (ArchiveItem, bool, error) {
	row := s.pool.QueryRow(ctx, archiveSelect+` WHERE a.sha256 = $1 LIMIT 1`, sha)
	item, err := scanArchive(row)
	if errors.Is(err, ErrNotFound) {
		return ArchiveItem{}, false, nil
	}
	if err != nil {
		return ArchiveItem{}, false, err
	}
	return item, true, nil
}

// ListArchives returns all indexed archives ordered by created_at DESC, id DESC.
func (s *Store) ListArchives(ctx context.Context) ([]ArchiveItem, error) {
	rows, err := s.pool.Query(ctx, archiveSelect+` WHERE a.status = 'indexed' ORDER BY a.created_at DESC, a.id DESC`)
	if err != nil {
		return nil, fmt.Errorf("listing archives: %w", err)
	}
	defer rows.Close()
	items := []ArchiveItem{}
	for rows.Next() {
		item, err := scanArchive(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

const archiveSelect = `
	SELECT a.id::text, a.owner_id::text, COALESCE(u.username, ''),
	       a.filename, a.format, a.size_bytes, a.sha256, a.is_encrypted,
	       a.status, a.file_count, a.dir_count, a.uncompressed_bytes, a.created_at
	FROM archives a
	LEFT JOIN users u ON u.id = a.owner_id
`

type rowScanner interface{ Scan(dest ...any) error }

func scanArchive(row rowScanner) (ArchiveItem, error) {
	var a ArchiveItem
	err := row.Scan(&a.ID, &a.OwnerID, &a.OwnerUsername, &a.Filename, &a.Format,
		&a.SizeBytes, &a.SHA256, &a.IsEncrypted, &a.Status, &a.FileCount,
		&a.DirCount, &a.UncompressedBytes, &a.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ArchiveItem{}, ErrNotFound
	}
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("scanning archive: %w", err)
	}
	return a, nil
}

// GetArchiveDetail returns the archive plus its entries. When query is empty,
// entries are filtered to parentPath (tree browsing, "" = root). When query is
// non-empty, it is a case-insensitive substring search across all paths.
func (s *Store) GetArchiveDetail(ctx context.Context, id, parentPath, query string) (ArchiveDetail, error) {
	archive, err := s.GetArchive(ctx, id)
	if err != nil {
		return ArchiveDetail{}, err
	}

	var entries []ArchiveEntry
	if query != "" {
		rows, err := s.pool.Query(ctx, `
			SELECT id, path, parent_path, name, is_dir, size_bytes, packed_bytes,
			       crc32, encrypted, modified_at
			FROM archive_entries
			WHERE archive_id = $1 AND position(lower($2) in lower(path)) > 0
			ORDER BY path ASC
			LIMIT 1000
		`, id, query)
		if err != nil {
			return ArchiveDetail{}, fmt.Errorf("searching archive entries: %w", err)
		}
		entries, err = collectArchiveEntries(rows)
		if err != nil {
			return ArchiveDetail{}, err
		}
	} else {
		rows, err := s.pool.Query(ctx, `
			SELECT id, path, parent_path, name, is_dir, size_bytes, packed_bytes,
			       crc32, encrypted, modified_at
			FROM archive_entries
			WHERE archive_id = $1 AND parent_path = $2
			ORDER BY is_dir DESC, name ASC
			LIMIT 1000
		`, id, parentPath)
		if err != nil {
			return ArchiveDetail{}, fmt.Errorf("browsing archive entries: %w", err)
		}
		entries, err = collectArchiveEntries(rows)
		if err != nil {
			return ArchiveDetail{}, err
		}
	}
	return ArchiveDetail{
		Archive:    archive,
		Entries:    entries,
		ParentPath: parentPath,
		Query:      query,
	}, nil
}

func collectArchiveEntries(rows pgx.Rows) ([]ArchiveEntry, error) {
	defer rows.Close()
	entries := []ArchiveEntry{}
	for rows.Next() {
		var e ArchiveEntry
		if err := rows.Scan(&e.ID, &e.Path, &e.ParentPath, &e.Name, &e.IsDir,
			&e.SizeBytes, &e.PackedBytes, &e.CRC32, &e.Encrypted, &e.ModifiedAt); err != nil {
			return nil, fmt.Errorf("scanning archive entry: %w", err)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// GetArchiveForUnlock loads the storage path and format for password
// verification and reindexing.
func (s *Store) GetArchiveForUnlock(ctx context.Context, id string) (storagePath, format, status string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT storage_path, format, status FROM archives WHERE id = $1
	`, id).Scan(&storagePath, &format, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	if err != nil {
		return "", "", "", fmt.Errorf("loading archive for unlock: %w", err)
	}
	return storagePath, format, status, nil
}

// UnlockArchive replaces the entries of a previously password_required archive
// with the freshly indexed rows, marks it indexed, and writes the
// archive.unlocked audit row in one transaction.
func (s *Store) UnlockArchive(ctx context.Context, id, actorID, archivePassword string, entries []archiveEntryInput) (ArchiveItem, error) {
	archivePassword = strings.Trim(strings.TrimSpace(archivePassword), "`'\"")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("beginning archive unlock: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	stats := NewEntryStats(entries)
	tag, err := tx.Exec(ctx, `
		UPDATE archives
		SET status = 'indexed', file_count = $2, dir_count = $3,
		    uncompressed_bytes = $4, archive_password = $5
		WHERE id = $1
	`, id, stats.FileCount, stats.DirCount, stats.UncompressedBytes, archivePassword)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("updating archive status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ArchiveItem{}, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `DELETE FROM archive_entries WHERE archive_id = $1`, id); err != nil {
		return ArchiveItem{}, fmt.Errorf("clearing archive entries: %w", err)
	}
	if len(entries) > 0 {
		if _, err := tx.CopyFrom(ctx,
			pgx.Identifier{"archive_entries"},
			[]string{"archive_id", "path", "parent_path", "name", "is_dir",
				"size_bytes", "packed_bytes", "crc32", "encrypted", "modified_at"},
			pgx.CopyFromSlice(len(entries), func(i int) ([]any, error) {
				e := entries[i]
				return []any{id, e.Path, e.ParentPath, e.Name, e.IsDir,
					e.SizeBytes, e.PackedBytes, e.CRC32, e.Encrypted, e.ModifiedAt}, nil
			})); err != nil {
			return ArchiveItem{}, fmt.Errorf("inserting archive entries: %w", err)
		}
	}
	if err := txAudit(ctx, tx, actorID, "archive.unlocked", "archive", id,
		map[string]any{"file_count": stats.FileCount, "dir_count": stats.DirCount}); err != nil {
		return ArchiveItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ArchiveItem{}, fmt.Errorf("committing archive unlock: %w", err)
	}
	return s.GetArchive(ctx, id)
}

// MarkArchiveDeleting marks an archive as deleting so it is immediately omitted from listings.
func (s *Store) MarkArchiveDeleting(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE archives SET status = 'deleting' WHERE id = $1`, id)
	return err
}

// DeleteArchive removes the archives row (cascading entries), deletes the
// stored file, and writes the archive.deleted audit row in one transaction.
func (s *Store) DeleteArchive(ctx context.Context, id, actorID string) (storagePath string, err error) {
	var path string
	err = s.pool.QueryRow(ctx, `SELECT storage_path FROM archives WHERE id = $1`, id).Scan(&path)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("loading archive for delete: %w", err)
	}

	// Direct indexed deletes run far faster than cascade triggers on large tables
	_, _ = s.pool.Exec(ctx, `DELETE FROM archive_cookie_domains WHERE archive_id = $1`, id)
	_, _ = s.pool.Exec(ctx, `DELETE FROM archive_entries WHERE archive_id = $1`, id)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("beginning archive delete: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `DELETE FROM archives WHERE id = $1`, id)
	if err != nil {
		return "", fmt.Errorf("deleting archive: %w", err)
	}
	if err := txAudit(ctx, tx, actorID, "archive.deleted", "archive", id,
		map[string]any{"filename": path}); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("committing archive delete: %w", err)
	}
	s.InvalidateCookieCache()
	return path, nil
}

// GetArchiveEntryForRead resolves one indexed entry by path along with the
// parent archive's filename, storage_path, format, and stored archive_password.
func (s *Store) GetArchiveEntryForRead(
	ctx context.Context,
	archiveID, entryPath string,
) (archiveFilename, storagePath, format, archivePassword string, entry ArchiveEntry, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT a.filename, a.storage_path, a.format, a.archive_password,
		       e.id, e.path, e.parent_path, e.name, e.is_dir,
		       e.size_bytes, e.packed_bytes, e.crc32, e.encrypted, e.modified_at
		FROM archives a
		JOIN archive_entries e ON e.archive_id = a.id
		WHERE a.id = $1 AND lower(e.path) = lower($2)
	`, archiveID, entryPath).Scan(
		&archiveFilename, &storagePath, &format, &archivePassword,
		&entry.ID, &entry.Path, &entry.ParentPath, &entry.Name, &entry.IsDir,
		&entry.SizeBytes, &entry.PackedBytes, &entry.CRC32, &entry.Encrypted, &entry.ModifiedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", "", ArchiveEntry{}, ErrNotFound
	}
	if err != nil {
		return "", "", "", "", ArchiveEntry{}, fmt.Errorf("loading archive entry: %w", err)
	}
	return archiveFilename, storagePath, format, archivePassword, entry, nil
}

// ArchiveRecord holds minimal archive metadata for reindexing.
type ArchiveRecord struct {
	ID              string
	Filename        string
	Format          string
	StoragePath     string
	ArchivePassword string
	IsEncrypted     bool
}

// GetAllArchivesForReindex loads all archive rows to re-run indexing.
func (s *Store) GetAllArchivesForReindex(ctx context.Context) ([]ArchiveRecord, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, filename, format, storage_path, archive_password, is_encrypted
		FROM archives
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("querying archives for reindex: %w", err)
	}
	defer rows.Close()

	var records []ArchiveRecord
	for rows.Next() {
		var r ArchiveRecord
		if err := rows.Scan(&r.ID, &r.Filename, &r.Format, &r.StoragePath, &r.ArchivePassword, &r.IsEncrypted); err != nil {
			return nil, err
		}
		records = append(records, r)
	}
	return records, rows.Err()
}

// GetArchiveForReindex loads a single archive row for reindexing.
func (s *Store) GetArchiveForReindex(ctx context.Context, id string) (ArchiveRecord, error) {
	var r ArchiveRecord
	err := s.pool.QueryRow(ctx, `
		SELECT id, filename, format, storage_path, archive_password, is_encrypted
		FROM archives
		WHERE id = $1
	`, id).Scan(&r.ID, &r.Filename, &r.Format, &r.StoragePath, &r.ArchivePassword, &r.IsEncrypted)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, fmt.Errorf("loading archive for reindex: %w", err)
	}
	return r, nil
}

// ApplyReindexedEntries updates the archive status, counts, and replaces all entries in one transaction.
func (s *Store) ApplyReindexedEntries(
	ctx context.Context,
	id, actorID string,
	entries []archiveEntryInput,
	status string,
) (ArchiveItem, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("beginning archive reindex transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	stats := NewEntryStats(entries)
	tag, err := tx.Exec(ctx, `
		UPDATE archives
		SET status = $2, file_count = $3, dir_count = $4,
		    uncompressed_bytes = $5
		WHERE id = $1
	`, id, status, stats.FileCount, stats.DirCount, stats.UncompressedBytes)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("updating archive status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ArchiveItem{}, ErrNotFound
	}

	if _, err := tx.Exec(ctx, `DELETE FROM archive_entries WHERE archive_id = $1`, id); err != nil {
		return ArchiveItem{}, fmt.Errorf("clearing archive entries: %w", err)
	}

	if len(entries) > 0 {
		if _, err := tx.CopyFrom(ctx,
			pgx.Identifier{"archive_entries"},
			[]string{"archive_id", "path", "parent_path", "name", "is_dir",
				"size_bytes", "packed_bytes", "crc32", "encrypted", "modified_at"},
			pgx.CopyFromSlice(len(entries), func(i int) ([]any, error) {
				e := entries[i]
				return []any{id, e.Path, e.ParentPath, e.Name, e.IsDir,
					e.SizeBytes, e.PackedBytes, e.CRC32, e.Encrypted, e.ModifiedAt}, nil
			})); err != nil {
			return ArchiveItem{}, fmt.Errorf("inserting reindexed entries: %w", err)
		}
	}

	if err := txAudit(ctx, tx, actorID, "archive.reindexed", "archive", id,
		map[string]any{"file_count": stats.FileCount, "dir_count": stats.DirCount, "status": status}); err != nil {
		return ArchiveItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ArchiveItem{}, fmt.Errorf("committing archive reindex: %w", err)
	}
	return s.GetArchive(ctx, id)
}

// StorageTypeStat represents size and count for a file extension.
type StorageTypeStat struct {
	Extension string `json:"extension"`
	Count     int64  `json:"count"`
	SizeBytes int64  `json:"sizeBytes"`
}

// StorageFormatStat represents count and packed size for an archive format.
type StorageFormatStat struct {
	Format    string `json:"format"`
	Count     int64  `json:"count"`
	SizeBytes int64  `json:"sizeBytes"`
}

// ArchiveSizeBreakdown represents one uploaded archive's storage vs uncompressed footprint.
type ArchiveSizeBreakdown struct {
	ID                string `json:"id"`
	Filename          string `json:"filename"`
	Format            string `json:"format"`
	PackedBytes       int64  `json:"packedBytes"`
	UncompressedBytes int64  `json:"uncompressedBytes"`
	FileCount         int    `json:"fileCount"`
	DirCount          int    `json:"dirCount"`
	Ratio             string `json:"ratio"`
}

// GlobalStorageStats captures overall storage and indexing metrics across the platform.
type GlobalStorageStats struct {
	TotalArchives          int64                  `json:"totalArchives"`
	TotalPackedBytes       int64                  `json:"totalPackedBytes"`
	TotalUncompressedBytes int64                  `json:"totalUncompressedBytes"`
	TotalFiles             int64                  `json:"totalFiles"`
	TotalDirs              int64                  `json:"totalDirs"`
	EncryptedVaults        int64                  `json:"encryptedVaults"`
	DiskTotalBytes         uint64                 `json:"diskTotalBytes"`
	DiskFreeBytes          uint64                 `json:"diskFreeBytes"`
	DiskUsedBytes          uint64                 `json:"diskUsedBytes"`
	FormatDistribution     []StorageFormatStat    `json:"formatDistribution"`
	ArchiveBreakdown       []ArchiveSizeBreakdown `json:"archiveBreakdown"`
}

// GetGlobalStorageStats calculates comprehensive metrics across all archives and the host disk.
func (s *Store) GetGlobalStorageStats(ctx context.Context, storageDir string) (GlobalStorageStats, error) {
	var stats GlobalStorageStats
	err := s.pool.QueryRow(ctx, `
		SELECT 
			count(*),
			coalesce(sum(size_bytes), 0),
			coalesce(sum(uncompressed_bytes), 0),
			coalesce(sum(file_count), 0),
			coalesce(sum(dir_count), 0),
			coalesce(count(*) FILTER (WHERE is_encrypted = true), 0)
		FROM archives;
	`).Scan(
		&stats.TotalArchives,
		&stats.TotalPackedBytes,
		&stats.TotalUncompressedBytes,
		&stats.TotalFiles,
		&stats.TotalDirs,
		&stats.EncryptedVaults,
	)
	if err != nil {
		return stats, fmt.Errorf("querying storage totals: %w", err)
	}

	fRows, err := s.pool.Query(ctx, `
		SELECT format, count(*), coalesce(sum(size_bytes), 0)
		FROM archives
		GROUP BY format
		ORDER BY count(*) DESC;
	`)
	if err == nil {
		defer fRows.Close()
		for fRows.Next() {
			var f StorageFormatStat
			if err := fRows.Scan(&f.Format, &f.Count, &f.SizeBytes); err == nil {
				stats.FormatDistribution = append(stats.FormatDistribution, f)
			}
		}
	}

	bRows, err := s.pool.Query(ctx, `
		SELECT 
			id, filename, format, size_bytes, uncompressed_bytes, file_count, dir_count,
			to_char(round((uncompressed_bytes::numeric / NULLIF(size_bytes, 0)), 2), 'FM990.09') || 'x' AS ratio
		FROM archives
		ORDER BY size_bytes DESC
		LIMIT 50;
	`)
	if err == nil {
		defer bRows.Close()
		for bRows.Next() {
			var b ArchiveSizeBreakdown
			if err := bRows.Scan(&b.ID, &b.Filename, &b.Format, &b.PackedBytes, &b.UncompressedBytes, &b.FileCount, &b.DirCount, &b.Ratio); err == nil {
				stats.ArchiveBreakdown = append(stats.ArchiveBreakdown, b)
			}
		}
	}

	return stats, nil
}

// CookieDomainInput represents one parsed domain chunk to insert.
type CookieDomainInput struct {
	EntryPath    string
	EntryName    string
	Domain       string
	CookieCount  int
	NetscapeText string
	JSONText     string
}
func sanitizePGText(s string) string {
	if strings.IndexByte(s, 0) >= 0 {
		s = strings.ReplaceAll(s, "\x00", "")
	}
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	return s
}

// SaveArchiveCookieDomains replaces all parsed domain cookie rows for an archive.
func (s *Store) SaveArchiveCookieDomains(ctx context.Context, archiveID string, chunks []CookieDomainInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `DELETE FROM archive_cookie_domains WHERE archive_id = $1`, archiveID); err != nil {
		return err
	}
	if len(chunks) > 0 {
		if _, err := tx.CopyFrom(
			ctx,
			pgx.Identifier{"archive_cookie_domains"},
			[]string{"archive_id", "entry_path", "entry_name", "domain", "cookie_count", "netscape_text", "json_text"},
			pgx.CopyFromSlice(len(chunks), func(i int) ([]any, error) {
				c := chunks[i]
				return []any{
					archiveID,
					sanitizePGText(c.EntryPath),
					sanitizePGText(c.EntryName),
					sanitizePGText(c.Domain),
					c.CookieCount,
					sanitizePGText(c.NetscapeText),
					sanitizePGText(c.JSONText),
				}, nil
			}),
		); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.InvalidateCookieCache()
	return nil
}

// InvalidateCookieCache clears the in-memory domain logs cache and refreshes domains asynchronously.
func (s *Store) InvalidateCookieCache() {
	s.cookieCache.logsMu.Lock()
	s.cookieCache.domainLogs = make(map[string][]CookieDomainLogItem)
	s.cookieCache.logsMu.Unlock()

	// Asynchronously warm without setting allDomains to nil
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		_ = s.ensureCookieDomainsLoaded(ctx)
	}()
}

// ensureCookieDomainsLoaded populates the in-memory domain list if not already cached.
func (s *Store) ensureCookieDomainsLoaded(ctx context.Context) error {
	s.cookieCache.mu.RLock()
	if s.cookieCache.populated {
		s.cookieCache.mu.RUnlock()
		return nil
	}
	s.cookieCache.mu.RUnlock()

	// Single-flight guard: only 1 background loader runs at a time
	if !s.cookieCache.loading.CompareAndSwap(false, true) {
		return nil
	}
	defer s.cookieCache.loading.Store(false)


	rows, err := s.pool.Query(ctx, `
		SELECT domain, count(*) AS log_count, coalesce(sum(cookie_count), 0) AS total_cookies
		FROM archive_cookie_domains
		GROUP BY domain
		ORDER BY log_count DESC, total_cookies DESC, domain ASC;
	`)
	if err != nil {
		return err
	}
	defer rows.Close()

	var all []CookieDomainSummary
	var tLogs, tCookies int64
	for rows.Next() {
		var d CookieDomainSummary
		if err := rows.Scan(&d.Domain, &d.LogCount, &d.TotalCookies); err != nil {
			return err
		}
		all = append(all, d)
		tLogs += d.LogCount
		tCookies += d.TotalCookies
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if all == nil {
		all = []CookieDomainSummary{}
	}
	s.cookieCache.mu.Lock()
	s.cookieCache.allDomains = all
	s.cookieCache.totalDomains = int64(len(all))
	s.cookieCache.totalLogs = tLogs
	s.cookieCache.totalCookies = tCookies
	s.cookieCache.populated = true
	s.cookieCache.mu.Unlock()
	return nil
}

// CookieDomainSummary aggregates stats for a single root domain across all archives.
type CookieDomainSummary struct {
	Domain       string `json:"domain"`
	LogCount     int64  `json:"logCount"`
	TotalCookies int64  `json:"totalCookies"`
}

// CookieDomainLogItem represents one log file's stripped cookies for a specific domain.
type CookieDomainLogItem struct {
	ID              int64  `json:"id"`
	ArchiveID       string `json:"archiveId"`
	ArchiveFilename string `json:"archiveFilename"`
	EntryPath       string `json:"entryPath"`
	EntryName       string `json:"entryName"`
	Domain          string `json:"domain"`
	CookieCount     int    `json:"cookieCount"`
	NetscapeText    string `json:"netscapeText"`
	JSONText        string `json:"jsonText"`
}

// ListCookieDomains returns paginated aggregated root domains and overall cookie statistics from the in-memory cache.
func (s *Store) ListCookieDomains(ctx context.Context, query string, limit, offset int) (
	domains []CookieDomainSummary,
	totalDomains int64,
	totalLogs int64,
	totalCookies int64,
	filteredCount int,
	err error,
) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	if err := s.ensureCookieDomainsLoaded(ctx); err != nil {
		return nil, 0, 0, 0, 0, err
	}

	s.cookieCache.mu.RLock()
	all := s.cookieCache.allDomains
	totalDomains = s.cookieCache.totalDomains
	totalLogs = s.cookieCache.totalLogs
	totalCookies = s.cookieCache.totalCookies
	s.cookieCache.mu.RUnlock()

	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		filteredCount = len(all)
		if offset >= len(all) {
			return []CookieDomainSummary{}, totalDomains, totalLogs, totalCookies, filteredCount, nil
		}
		end := offset + limit
		if end > len(all) {
			end = len(all)
		}
		domains = all[offset:end]
		if domains == nil {
			domains = []CookieDomainSummary{}
		}
		return domains, totalDomains, totalLogs, totalCookies, filteredCount, nil
	}

	// In-memory filter across all 1.23M domains
	matches := make([]CookieDomainSummary, 0, 256)
	for _, d := range all {
		if strings.Contains(strings.ToLower(d.Domain), q) {
			matches = append(matches, d)
		}
	}
	filteredCount = len(matches)
	if offset >= len(matches) {
		return []CookieDomainSummary{}, totalDomains, totalLogs, totalCookies, filteredCount, nil
	}
	end := offset + limit
	if end > len(matches) {
		end = len(matches)
	}
	domains = matches[offset:end]
	if domains == nil {
		domains = []CookieDomainSummary{}
	}
	return domains, totalDomains, totalLogs, totalCookies, filteredCount, nil
}

// ListLogsForCookieDomain returns the individual per-log stripped cookies for a domain, using an in-memory cache.
func (s *Store) ListLogsForCookieDomain(ctx context.Context, domain, query string, limit int) ([]CookieDomainLogItem, error) {
	if limit <= 0 || limit > 500 {
		limit = 250
	}

	s.cookieCache.logsMu.RLock()
	cachedLogs, ok := s.cookieCache.domainLogs[domain]
	s.cookieCache.logsMu.RUnlock()

	if !ok {
		rows, err := s.pool.Query(ctx, `
			SELECT c.id, c.archive_id, a.filename, c.entry_path, c.entry_name, c.domain, c.cookie_count, c.netscape_text, c.json_text
			FROM archive_cookie_domains c
			JOIN archives a ON a.id = c.archive_id
			WHERE c.domain = $1
			ORDER BY c.cookie_count DESC, c.id DESC
			LIMIT 250;
		`, domain)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		var fetched []CookieDomainLogItem
		for rows.Next() {
			var it CookieDomainLogItem
			if err := rows.Scan(&it.ID, &it.ArchiveID, &it.ArchiveFilename, &it.EntryPath, &it.EntryName, &it.Domain, &it.CookieCount, &it.NetscapeText, &it.JSONText); err != nil {
				return nil, err
			}
			fetched = append(fetched, it)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if fetched == nil {
			fetched = []CookieDomainLogItem{}
		}

		s.cookieCache.logsMu.Lock()
		if s.cookieCache.domainLogs == nil {
			s.cookieCache.domainLogs = make(map[string][]CookieDomainLogItem)
		}
		// Bound cache size to 256 domains
		if len(s.cookieCache.domainLogs) >= 256 {
			for k := range s.cookieCache.domainLogs {
				delete(s.cookieCache.domainLogs, k)
				break
			}
		}
		s.cookieCache.domainLogs[domain] = fetched
		s.cookieCache.logsMu.Unlock()
		cachedLogs = fetched
	}

	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		if len(cachedLogs) > limit {
			return cachedLogs[:limit], nil
		}
		return cachedLogs, nil
	}

	filtered := make([]CookieDomainLogItem, 0, len(cachedLogs))
	for _, it := range cachedLogs {
		if strings.Contains(strings.ToLower(it.EntryPath), q) || strings.Contains(strings.ToLower(it.ArchiveFilename), q) {
			filtered = append(filtered, it)
			if len(filtered) >= limit {
				break
			}
		}
	}
	return filtered, nil
}

// GetCookieLogsForDownload fetches all or N random log cookie files for a domain.
func (s *Store) GetCookieLogsForDownload(ctx context.Context, domain string, randomCount int) ([]CookieDomainLogItem, error) {
	var rows pgx.Rows
	var err error
	if randomCount > 0 {
		rows, err = s.pool.Query(ctx, `
			SELECT c.id, c.archive_id, a.filename, c.entry_path, c.entry_name, c.domain, c.cookie_count, c.netscape_text, c.json_text
			FROM archive_cookie_domains c
			JOIN archives a ON a.id = c.archive_id
			WHERE c.domain = $1
			ORDER BY random()
			LIMIT $2;
		`, domain, randomCount)
	} else {
		rows, err = s.pool.Query(ctx, `
			SELECT c.id, c.archive_id, a.filename, c.entry_path, c.entry_name, c.domain, c.cookie_count, c.netscape_text, c.json_text
			FROM archive_cookie_domains c
			JOIN archives a ON a.id = c.archive_id
			WHERE c.domain = $1
			ORDER BY c.id ASC;
		`, domain)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []CookieDomainLogItem
	for rows.Next() {
		var it CookieDomainLogItem
		if err := rows.Scan(&it.ID, &it.ArchiveID, &it.ArchiveFilename, &it.EntryPath, &it.EntryName, &it.Domain, &it.CookieCount, &it.NetscapeText, &it.JSONText); err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, rows.Err()
}

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
	if !strings.ContainsAny(s, ` /\\`) && strings.Contains(s, ".") {
		ext := filepath.Ext(s)
		if len(ext) >= 2 && len(ext) <= 6 && !strings.HasPrefix(s, ".") {
			return s, "exact"
		}
	}
	// 4. Default: substring
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
		_ = s.pool.QueryRow(ctx, `SELECT reltuples::bigint FROM pg_class WHERE relname = 'archive_entries'`).Scan(&countTotal)

		rows, err := s.pool.Query(ctx, `
			SELECT e.id, e.archive_id, a.filename, e.path, e.name, 
			       e.size_bytes, e.packed_bytes, e.crc32, e.encrypted, e.modified_at
			FROM archive_entries e
			JOIN archives a ON a.id = e.archive_id
			WHERE e.is_dir = false
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

	whereClauses := []string{"e.is_dir = false"}
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
			addCond("lower(e.name) LIKE '%%' || lower($%d) || '%%'", fn)
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
			clause := fmt.Sprintf("(lower(e.name) LIKE '%%' || lower($%d) || '%%' OR lower(e.path) LIKE '%%' || lower($%d) || '%%')", argID, argID+1)
			whereClauses = append(whereClauses, clause)
			args = append(args, q, q)
			argID += 2
		}
	}

	whereSQL := strings.Join(whereClauses, " AND ")

	// Get count (capped timeout/estimate for instant response)
	var countTotal int64
	countSQL := fmt.Sprintf("SELECT count(*) FROM archive_entries e WHERE %s", whereSQL)
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

// GetArchivePasswords loads the user-configured archive password dictionary from app_settings.
func (s *Store) GetArchivePasswords(ctx context.Context) ([]string, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `
		SELECT value::text FROM app_settings WHERE key = 'archive_passwords';
	`).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("loading archive passwords: %w", err)
	}
	var pws []string
	if jerr := json.Unmarshal(raw, &pws); jerr != nil {
		return nil, fmt.Errorf("decoding archive passwords: %w", jerr)
	}
	return pws, nil
}

// SetArchivePasswords persists the updated archive password dictionary into app_settings.
func (s *Store) SetArchivePasswords(ctx context.Context, pws []string, actorID string) error {
	seen := make(map[string]bool)
	var clean []string
	for _, p := range pws {
		t := strings.TrimSpace(p)
		if t != "" && !seen[t] {
			seen[t] = true
			clean = append(clean, t)
		}
	}
	b, err := json.Marshal(clean)
	if err != nil {
		return err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `
		INSERT INTO app_settings (key, value, updated_at)
		VALUES ('archive_passwords', $1::jsonb, now())
		ON CONFLICT (key) DO UPDATE
		SET value = EXCLUDED.value, updated_at = now();
	`, string(b))
	if err != nil {
		return fmt.Errorf("saving archive passwords: %w", err)
	}
	if err := txAudit(ctx, tx, actorID, "settings.update_archive_passwords", "settings", "archive_passwords", map[string]any{
		"password_count": len(clean),
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetExistingArchivesMap returns a map from lowercase filename to all known size_bytes in the vault.
func (s *Store) GetExistingArchivesMap(ctx context.Context) (map[string][]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT lower(filename), size_bytes FROM archives;`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string][]int64)
	for rows.Next() {
		var fn string
		var sz int64
		if err := rows.Scan(&fn, &sz); err == nil {
			cleanFn := strings.ToLower(strings.TrimSpace(fn))
			m[cleanFn] = append(m[cleanFn], sz)
		}
	}
	return m, rows.Err()
}

// IsArchived reports whether an archive with matching filename and size exists in the vault.
// If sizeBytes <= 0, it falls back to checking filename existence.
func IsArchived(existingMap map[string][]int64, filename string, sizeBytes int64) bool {
	if existingMap == nil {
		return false
	}
	cleanFn := strings.ToLower(strings.TrimSpace(filename))
	sizes, exists := existingMap[cleanFn]
	if !exists {
		return false
	}
	if sizeBytes <= 0 {
		return true
	}
	for _, sz := range sizes {
		if sz == sizeBytes {
			return true
		}
	}
	return false
}

// GetExistingArchiveFilenames returns a set of all lowercase filenames currently in the archives table.
func (s *Store) GetExistingArchiveFilenames(ctx context.Context) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT lower(filename) FROM archives;`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]bool)
	for rows.Next() {
		var fn string
		if err := rows.Scan(&fn); err == nil {
			m[strings.ToLower(strings.TrimSpace(fn))] = true
		}
	}
	return m, rows.Err()
}
