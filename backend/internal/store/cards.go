package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

type CardInput struct {
	EntryPath string
	EntryName string
	Holder    string
	Number    string
	ExpMonth  string
	ExpYear   string
	CVV       string
	Brand     string
}

type CardItem struct {
	ID              int64  `json:"id"`
	ArchiveID       string `json:"archiveId"`
	ArchiveFilename string `json:"archiveFilename"`
	EntryPath       string `json:"entryPath"`
	EntryName       string `json:"entryName"`
	Holder          string `json:"holder"`
	Number          string `json:"number"`
	ExpMonth        string `json:"expMonth"`
	ExpYear         string `json:"expYear"`
	CVV             string `json:"cvv"`
	Brand           string `json:"brand"`
}

// SaveArchiveCards replaces all parsed credit card rows for an archive.
func (s *Store) SaveArchiveCards(ctx context.Context, archiveID string, rows []CardInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `DELETE FROM archive_cards WHERE archive_id = $1`, archiveID); err != nil {
		return err
	}

	if len(rows) > 0 {
		if _, err := tx.CopyFrom(
			ctx,
			pgx.Identifier{"archive_cards"},
			[]string{"archive_id", "entry_path", "entry_name", "holder", "number", "exp_month", "exp_year", "cvv", "brand"},
			pgx.CopyFromSlice(len(rows), func(i int) ([]any, error) {
				r := rows[i]
				return []any{
					archiveID,
					sanitizePGText(r.EntryPath),
					sanitizePGText(r.EntryName),
					sanitizePGText(r.Holder),
					sanitizePGText(r.Number),
					sanitizePGText(r.ExpMonth),
					sanitizePGText(r.ExpYear),
					sanitizePGText(r.CVV),
					sanitizePGText(r.Brand),
				}, nil
			}),
		); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// SearchCards queries indexed cards matching cardholder name, card number, or brand,
// or returns newest cards if query is empty.
func (s *Store) SearchCards(ctx context.Context, query string, limit, offset int) ([]CardItem, int64, error) {
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
		err := s.pool.QueryRow(ctx, `SELECT reltuples::bigint FROM pg_class WHERE relname = 'archive_cards'`).Scan(&totalCount)
		if err != nil || totalCount <= 0 {
			if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM archive_cards`).Scan(&totalCount); err != nil {
				return nil, 0, fmt.Errorf("counting cards: %w", err)
			}
		}

		if totalCount == 0 {
			return []CardItem{}, 0, nil
		}

		rows, err := s.pool.Query(ctx, `
			SELECT c.id, c.archive_id, coalesce(a.filename, ''), c.entry_path, c.entry_name, c.holder, c.number, c.exp_month, c.exp_year, c.cvv, c.brand
			FROM archive_cards c
			JOIN archives a ON a.id = c.archive_id
			ORDER BY c.id DESC
			LIMIT $1 OFFSET $2;
		`, limit, offset)
		if err != nil {
			return nil, 0, fmt.Errorf("searching cards: %w", err)
		}
		defer rows.Close()

		results, err := scanCardItems(rows, limit)
		if err != nil {
			return nil, 0, fmt.Errorf("reading cards: %w", err)
		}
		return results, totalCount, nil
	}

	escaped := escapeLike(cleanQuery)
	predicate := "lower(c.holder) LIKE '%' || lower($1) || '%' OR lower(c.number) LIKE '%' || lower($1) || '%' OR lower(c.brand) LIKE '%' || lower($1) || '%'"

	var totalCount int64
	if err := s.pool.QueryRow(ctx, fmt.Sprintf(`
		SELECT count(*)
		FROM archive_cards c
		WHERE %s
	`, predicate), escaped).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("counting matching cards: %w", err)
	}

	if totalCount == 0 {
		return []CardItem{}, 0, nil
	}

	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT c.id, c.archive_id, coalesce(a.filename, ''), c.entry_path, c.entry_name, c.holder, c.number, c.exp_month, c.exp_year, c.cvv, c.brand
		FROM archive_cards c
		JOIN archives a ON a.id = c.archive_id
		WHERE %s
		ORDER BY c.id DESC
		LIMIT $2 OFFSET $3;
	`, predicate), escaped, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("searching cards: %w", err)
	}
	defer rows.Close()

	results, err := scanCardItems(rows, limit)
	if err != nil {
		return nil, 0, fmt.Errorf("reading cards: %w", err)
	}
	return results, totalCount, nil
}

func scanCardItems(rows pgx.Rows, limit int) ([]CardItem, error) {
	results := make([]CardItem, 0, limit)
	for rows.Next() {
		var item CardItem
		if err := rows.Scan(
			&item.ID,
			&item.ArchiveID,
			&item.ArchiveFilename,
			&item.EntryPath,
			&item.EntryName,
			&item.Holder,
			&item.Number,
			&item.ExpMonth,
			&item.ExpYear,
			&item.CVV,
			&item.Brand,
		); err != nil {
			return nil, err
		}
		results = append(results, item)
	}
	return results, rows.Err()
}
