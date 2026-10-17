package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

type CredentialInput struct {
	EntryPath string
	EntryName string
	URL       string
	Domain    string
	Login     string
	Password  string
}

type CredentialItem struct {
	ID              int64  `json:"id"`
	ArchiveID       string `json:"archiveId"`
	ArchiveFilename string `json:"archiveFilename"`
	EntryPath       string `json:"entryPath"`
	EntryName       string `json:"entryName"`
	URL             string `json:"url"`
	Domain          string `json:"domain"`
	Login           string `json:"login"`
	Password        string `json:"password"`
}

// SaveArchiveCredentials replaces all parsed credential rows for an archive.
func (s *Store) SaveArchiveCredentials(ctx context.Context, archiveID string, rows []CredentialInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `DELETE FROM archive_credentials WHERE archive_id = $1`, archiveID); err != nil {
		return err
	}

	if len(rows) > 0 {
		if _, err := tx.CopyFrom(
			ctx,
			pgx.Identifier{"archive_credentials"},
			[]string{"archive_id", "entry_path", "entry_name", "url", "domain", "login", "password"},
			pgx.CopyFromSlice(len(rows), func(i int) ([]any, error) {
				r := rows[i]
				return []any{
					archiveID,
					sanitizePGText(r.EntryPath),
					sanitizePGText(r.EntryName),
					sanitizePGText(r.URL),
					sanitizePGText(r.Domain),
					sanitizePGText(r.Login),
					sanitizePGText(r.Password),
				}, nil
			}),
		); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

// SearchCredentials queries indexed credentials matching domain or url, or returns newest credentials if query is empty.
func (s *Store) SearchCredentials(ctx context.Context, query string, limit, offset int) ([]CredentialItem, int64, error) {
	if limit <= 0 {
		limit = 100
	} else if limit > 1000 {
		limit = 1000
	}
	if offset < 0 {
		offset = 0
	}

	cleanQuery := sanitizePGText(strings.TrimSpace(query))

	if cleanQuery == "" {
		var totalCount int64
		err := s.pool.QueryRow(ctx, `SELECT reltuples::bigint FROM pg_class WHERE relname = 'archive_credentials'`).Scan(&totalCount)
		if err != nil || totalCount <= 0 {
			if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM archive_credentials`).Scan(&totalCount); err != nil {
				return nil, 0, fmt.Errorf("counting credentials: %w", err)
			}
		}

		if totalCount == 0 {
			return []CredentialItem{}, 0, nil
		}

		rows, err := s.pool.Query(ctx, `
			SELECT c.id, c.archive_id, coalesce(a.filename, ''), c.entry_path, c.entry_name, c.url, c.domain, c.login, c.password
			FROM archive_credentials c
			JOIN archives a ON a.id = c.archive_id
			ORDER BY c.id DESC
			LIMIT $1 OFFSET $2;
		`, limit, offset)
		if err != nil {
			return nil, 0, fmt.Errorf("searching credentials: %w", err)
		}
		defer rows.Close()

		results, err := scanCredentialItems(rows, limit)
		if err != nil {
			return nil, 0, fmt.Errorf("reading credentials: %w", err)
		}
		return results, totalCount, nil
	}

	escaped := escapeLike(cleanQuery)

	var totalCount int64
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM archive_credentials c
		WHERE lower(c.domain) LIKE '%' || lower($1) || '%' OR lower(c.url) LIKE '%' || lower($1) || '%'
	`, escaped).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("counting matching credentials: %w", err)
	}

	if totalCount == 0 {
		return []CredentialItem{}, 0, nil
	}

	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.archive_id, coalesce(a.filename, ''), c.entry_path, c.entry_name, c.url, c.domain, c.login, c.password
		FROM archive_credentials c
		JOIN archives a ON a.id = c.archive_id
		WHERE lower(c.domain) LIKE '%' || lower($1) || '%' OR lower(c.url) LIKE '%' || lower($1) || '%'
		ORDER BY c.id DESC
		LIMIT $2 OFFSET $3;
	`, escaped, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("searching credentials: %w", err)
	}
	defer rows.Close()

	results, err := scanCredentialItems(rows, limit)
	if err != nil {
		return nil, 0, fmt.Errorf("reading credentials: %w", err)
	}
	return results, totalCount, nil
}

func scanCredentialItems(rows pgx.Rows, limit int) ([]CredentialItem, error) {
	results := make([]CredentialItem, 0, limit)
	for rows.Next() {
		var item CredentialItem
		if err := rows.Scan(
			&item.ID,
			&item.ArchiveID,
			&item.ArchiveFilename,
			&item.EntryPath,
			&item.EntryName,
			&item.URL,
			&item.Domain,
			&item.Login,
			&item.Password,
		); err != nil {
			return nil, err
		}
		results = append(results, item)
	}
	return results, rows.Err()
}
