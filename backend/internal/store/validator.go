package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ValidationItem represents one cookie log entry inside the validator queue.
type ValidationItem struct {
	ID              string     `json:"id"`
	Service         string     `json:"service"`
	Domain          string     `json:"domain"`
	ArchiveID       *string    `json:"archiveId,omitempty"`
	ArchiveFilename string     `json:"archiveFilename"`
	EntryPath       string     `json:"entryPath"`
	CookieCount     int        `json:"cookieCount"`
	CookieText      string     `json:"cookieText"`
	Status          string     `json:"status"` // "not_checked", "valid", "not_valid"
	CheckedAt       *time.Time `json:"checkedAt,omitempty"`
	ErrorMessage    string     `json:"errorMessage,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
}

// ValidationSummary contains summary counts for the current validation service queue.
type ValidationSummary struct {
	Total       int `json:"total"`
	NotChecked  int `json:"notChecked"`
	Valid       int `json:"valid"`
	NotValid    int `json:"notValid"`
}

// ListValidationItems retrieves items matching service and optional status filter.
func (s *Store) ListValidationItems(ctx context.Context, service, status string, limit, offset int) ([]ValidationItem, ValidationSummary, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	service = strings.ToLower(strings.TrimSpace(service))
	if service == "" {
		service = "chatgpt"
	}

	// 1. Get summary counts
	var summary ValidationSummary
	countRows, err := s.pool.Query(ctx, `
		SELECT status, count(*)
		FROM cookie_validation_items
		WHERE service = $1
		GROUP BY status;
	`, service)
	if err == nil {
		defer countRows.Close()
		for countRows.Next() {
			var st string
			var cnt int
			if err := countRows.Scan(&st, &cnt); err == nil {
				summary.Total += cnt
				switch st {
				case "valid":
					summary.Valid = cnt
				case "not_valid":
					summary.NotValid = cnt
				case "not_checked":
					summary.NotChecked = cnt
				}
			}
		}
	}

	// 2. Query items
	var rows pgx.Rows
	status = strings.ToLower(strings.TrimSpace(status))
	if status == "valid" || status == "not_valid" || status == "not_checked" {
		rows, err = s.pool.Query(ctx, `
			SELECT id::text, service, domain, archive_id::text, archive_filename,
			       entry_path, cookie_count, cookie_text, status, checked_at,
			       error_message, created_at
			FROM cookie_validation_items
			WHERE service = $1 AND status = $2
			ORDER BY created_at DESC, id DESC
			LIMIT $3 OFFSET $4;
		`, service, status, limit, offset)
	} else {
		rows, err = s.pool.Query(ctx, `
			SELECT id::text, service, domain, archive_id::text, archive_filename,
			       entry_path, cookie_count, cookie_text, status, checked_at,
			       error_message, created_at
			FROM cookie_validation_items
			WHERE service = $1
			ORDER BY created_at DESC, id DESC
			LIMIT $2 OFFSET $3;
		`, service, limit, offset)
	}
	if err != nil {
		return nil, summary, fmt.Errorf("querying validation items: %w", err)
	}
	defer rows.Close()

	var items []ValidationItem
	for rows.Next() {
		var it ValidationItem
		var aid *string
		if err := rows.Scan(&it.ID, &it.Service, &it.Domain, &aid, &it.ArchiveFilename,
			&it.EntryPath, &it.CookieCount, &it.CookieText, &it.Status, &it.CheckedAt,
			&it.ErrorMessage, &it.CreatedAt); err != nil {
			return nil, summary, err
		}
		it.ArchiveID = aid
		items = append(items, it)
	}
	if items == nil {
		items = []ValidationItem{}
	}
	return items, summary, rows.Err()
}

// AddValidationDomain queues all parsed logs for a domain into the validator.
func (s *Store) AddValidationDomain(ctx context.Context, domain, service string) (int, error) {
	domain = strings.ToLower(strings.TrimSpace(domain))
	service = strings.ToLower(strings.TrimSpace(service))
	if service == "" {
		service = "chatgpt"
	}
	if domain == "" {
		return 0, errors.New("domain is required")
	}

	rows, err := s.pool.Query(ctx, `
		SELECT c.archive_id, a.filename, c.entry_path, c.domain, c.cookie_count, c.netscape_text
		FROM archive_cookie_domains c
		JOIN archives a ON a.id = c.archive_id
		WHERE c.domain = $1
		ORDER BY c.cookie_count DESC
		LIMIT 500;
	`, domain)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type logRow struct {
		archiveID string
		filename  string
		entryPath string
		domain    string
		count     int
		text      string
	}
	var logs []logRow
	for rows.Next() {
		var r logRow
		if err := rows.Scan(&r.archiveID, &r.filename, &r.entryPath, &r.domain, &r.count, &r.text); err == nil {
			logs = append(logs, r)
		}
	}
	if len(logs) == 0 {
		return 0, nil
	}

	batch := &pgx.Batch{}
	for _, l := range logs {
		batch.Queue(`
			INSERT INTO cookie_validation_items
				(service, domain, archive_id, archive_filename, entry_path, cookie_count, cookie_text, status)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'not_checked');
		`, service, l.domain, l.archiveID, l.filename, l.entryPath, l.count, l.text)
	}

	br := s.pool.SendBatch(ctx, batch)
	defer br.Close()

	inserted := 0
	for range logs {
		if _, err := br.Exec(); err == nil {
			inserted++
		}
	}

	// Automatically run validation immediately in background
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		_, _ = s.CheckValidationItems(bgCtx, service, nil)
	}()
	return inserted, nil
}

// AddValidationLog queues a single archive cookie log into the validator.
func (s *Store) AddValidationLog(ctx context.Context, logID int64, service string) (string, error) {
	service = strings.ToLower(strings.TrimSpace(service))
	if service == "" {
		service = "chatgpt"
	}

	var archiveID, filename, entryPath, domain, netscapeText string
	var cookieCount int

	err := s.pool.QueryRow(ctx, `
		SELECT c.archive_id::text, a.filename, c.entry_path, c.domain, c.cookie_count, c.netscape_text
		FROM archive_cookie_domains c
		JOIN archives a ON a.id = c.archive_id
		WHERE c.id = $1;
	`, logID).Scan(&archiveID, &filename, &entryPath, &domain, &cookieCount, &netscapeText)
	if err != nil {
		return "", fmt.Errorf("loading cookie log %d: %w", logID, err)
	}

	var insertedID string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO cookie_validation_items
			(service, domain, archive_id, archive_filename, entry_path, cookie_count, cookie_text, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'not_checked')
		RETURNING id::text;
	`, service, domain, archiveID, filename, entryPath, cookieCount, netscapeText).Scan(&insertedID)
	if err == nil && insertedID != "" {
		go func() {
			bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_, _ = s.CheckValidationItems(bgCtx, service, []string{insertedID})
		}()
	}
	return insertedID, err
}

// AddValidationCustom queues manually pasted custom cookie text into the validator.
func (s *Store) AddValidationCustom(ctx context.Context, domain, service, cookieText string) (string, error) {
	service = strings.ToLower(strings.TrimSpace(service))
	if service == "" {
		service = "chatgpt"
	}
	domain = strings.ToLower(strings.TrimSpace(domain))
	if domain == "" {
		domain = "openai.com"
	}

	cookieText = sanitizePGText(strings.TrimSpace(cookieText))
	lines := strings.Split(cookieText, "\n")
	count := 0
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l != "" && !strings.HasPrefix(l, "#") {
			count++
		}
	}
	if count == 0 {
		count = 1
	}

	var insertedID string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO cookie_validation_items
			(service, domain, archive_filename, entry_path, cookie_count, cookie_text, status)
		VALUES ($1, $2, 'Manual Entry', 'custom/cookies.txt', $3, $4, 'not_checked')
		RETURNING id::text;
	`, service, domain, count, cookieText).Scan(&insertedID)
	if err == nil && insertedID != "" {
		go func() {
			bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_, _ = s.CheckValidationItems(bgCtx, service, []string{insertedID})
		}()
	}
	return insertedID, err
}
// CheckValidationItems runs validation check on items (simulated/placeholder checker).
func (s *Store) CheckValidationItems(ctx context.Context, service string, ids []string) (int, error) {
	service = strings.ToLower(strings.TrimSpace(service))
	if service == "" {
		service = "chatgpt"
	}

	var rows pgx.Rows
	var err error
	if len(ids) > 0 {
		rows, err = s.pool.Query(ctx, `
			SELECT id, cookie_text, cookie_count
			FROM cookie_validation_items
			WHERE service = $1 AND id = ANY($2);
		`, service, ids)
	} else {
		rows, err = s.pool.Query(ctx, `
			SELECT id, cookie_text, cookie_count
			FROM cookie_validation_items
			WHERE service = $1 AND status = 'not_checked'
			LIMIT 500;
		`, service)
	}
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type toCheck struct {
		id    string
		text  string
		count int
	}
	var items []toCheck
	for rows.Next() {
		var it toCheck
		if err := rows.Scan(&it.id, &it.text, &it.count); err == nil {
			items = append(items, it)
		}
	}

	now := time.Now()
	batch := &pgx.Batch{}

	for _, it := range items {
		status := "valid"
		errMsg := ""

		lowerText := strings.ToLower(it.text)
		// Specifically check for auth.openai.com cookies and session tokens
		hasAuthOpenAI := strings.Contains(lowerText, "auth.openai.com") || strings.Contains(lowerText, ".auth.openai.com")
		hasSessionToken := strings.Contains(lowerText, "__secure-next-auth.session-token") ||
			strings.Contains(lowerText, "session-token") ||
			strings.Contains(lowerText, "oai-did") ||
			strings.Contains(lowerText, "sess-")

		if hasAuthOpenAI && hasSessionToken {
			status = "valid"
			errMsg = ""
		} else if !hasAuthOpenAI {
			status = "not_valid"
			errMsg = "Missing auth.openai.com session token"
		} else {
			status = "not_valid"
			errMsg = "Malformed or expired auth.openai.com token"
		}

		batch.Queue(`
			UPDATE cookie_validation_items
			SET status = $1, checked_at = $2, error_message = $3
			WHERE id = $4;
		`, status, now, errMsg, it.id)
	}

	br := s.pool.SendBatch(ctx, batch)
	defer br.Close()

	checked := 0
	for range items {
		if _, err := br.Exec(); err == nil {
			checked++
		}
	}
	return checked, nil
}

// ClearValidationItems purges items from the validator queue.
func (s *Store) ClearValidationItems(ctx context.Context, service string) error {
	service = strings.ToLower(strings.TrimSpace(service))
	if service == "" {
		service = "chatgpt"
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM cookie_validation_items WHERE service = $1;`, service)
	return err
}

// GetValidCookiesExport gathers all valid cookie texts for export.
func (s *Store) GetValidCookiesExport(ctx context.Context, service string) (string, error) {
	service = strings.ToLower(strings.TrimSpace(service))
	if service == "" {
		service = "chatgpt"
	}

	rows, err := s.pool.Query(ctx, `
		SELECT cookie_text
		FROM cookie_validation_items
		WHERE service = $1 AND status = 'valid'
		ORDER BY created_at DESC;
	`, service)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	var sb strings.Builder
	sb.WriteString("# Netscape HTTP Cookie File - Validated Export\n")
	sb.WriteString(fmt.Sprintf("# Service: %s\n", service))
	sb.WriteString(fmt.Sprintf("# Generated: %s\n\n", time.Now().UTC().Format(time.RFC3339)))

	for rows.Next() {
		var text string
		if err := rows.Scan(&text); err == nil && text != "" {
			sb.WriteString(text)
			if !strings.HasSuffix(text, "\n") {
				sb.WriteString("\n")
			}
		}
	}
	return sb.String(), rows.Err()
}
