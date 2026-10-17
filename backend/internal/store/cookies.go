package store

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"archive/backend/internal/archiveidx"
	"github.com/jackc/pgx/v5"
)

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

	s.cookieCache.mu.Lock()
	s.cookieCache.populated = false
	s.cookieCache.version++
	s.cookieCache.mu.Unlock()

	// Asynchronously reload domain summaries without clearing allDomains mid-flight
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		_ = s.reloadCookieDomains(ctx)
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

	return s.reloadCookieDomains(ctx)
}

// reloadCookieDomains executes the domain aggregation query outside any lock and
// atomically swaps the in-memory cookie domain summary cache.
func (s *Store) reloadCookieDomains(ctx context.Context) error {
	for {
		s.cookieCache.mu.Lock()
		if s.cookieCache.waitCh != nil {
			ch := s.cookieCache.waitCh
			s.cookieCache.mu.Unlock()
			select {
			case <-ch:
			case <-ctx.Done():
				return ctx.Err()
			}
			s.cookieCache.mu.RLock()
			pop := s.cookieCache.populated
			s.cookieCache.mu.RUnlock()
			if pop {
				return nil
			}
			continue
		}
		ch := make(chan struct{})
		s.cookieCache.waitCh = ch
		startVer := s.cookieCache.version
		s.cookieCache.loading.Store(true)
		s.cookieCache.mu.Unlock()

		all, tLogs, tCookies, err := s.queryCookieDomainSummaries(ctx)

		s.cookieCache.mu.Lock()
		s.cookieCache.loading.Store(false)
		s.cookieCache.waitCh = nil
		if err == nil {
			s.cookieCache.allDomains = all
			s.cookieCache.totalDomains = int64(len(all))
			s.cookieCache.totalLogs = tLogs
			s.cookieCache.totalCookies = tCookies
			if s.cookieCache.version == startVer {
				s.cookieCache.populated = true
			}
		}
		close(ch)
		needRerun := err == nil && s.cookieCache.version != startVer
		s.cookieCache.mu.Unlock()

		if err != nil {
			return err
		}
		if !needRerun {
			return nil
		}
	}
}

func (s *Store) queryCookieDomainSummaries(ctx context.Context) ([]CookieDomainSummary, int64, int64, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.domain, count(*) AS log_count, coalesce(sum(c.cookie_count), 0) AS total_cookies
		FROM archive_cookie_domains c
		JOIN archives a ON a.id = c.archive_id
		WHERE a.status = 'indexed'
		GROUP BY c.domain
		ORDER BY log_count DESC, total_cookies DESC, c.domain ASC;
	`)
	if err != nil {
		return nil, 0, 0, err
	}
	defer rows.Close()

	var all []CookieDomainSummary
	var tLogs, tCookies int64
	for rows.Next() {
		var d CookieDomainSummary
		if err := rows.Scan(&d.Domain, &d.LogCount, &d.TotalCookies); err != nil {
			return nil, 0, 0, err
		}
		all = append(all, d)
		tLogs += d.LogCount
		tCookies += d.TotalCookies
	}
	if err := rows.Err(); err != nil {
		return nil, 0, 0, err
	}
	if all == nil {
		all = []CookieDomainSummary{}
	}
	return all, tLogs, tCookies, nil
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
	if norm := archiveidx.NormalizeRootDomain(domain); norm != "" {
		domain = norm
	} else {
		domain = strings.ToLower(strings.TrimSpace(domain))
	}

	s.cookieCache.logsMu.RLock()
	cachedLogs, ok := s.cookieCache.domainLogs[domain]
	s.cookieCache.logsMu.RUnlock()

	if !ok {
		rows, err := s.pool.Query(ctx, `
			SELECT c.id, c.archive_id, a.filename, c.entry_path, c.entry_name, c.domain, c.cookie_count, c.netscape_text, c.json_text
			FROM archive_cookie_domains c
			JOIN archives a ON a.id = c.archive_id
			WHERE c.domain = $1 AND a.status = 'indexed'
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
	if norm := archiveidx.NormalizeRootDomain(domain); norm != "" {
		domain = norm
	} else {
		domain = strings.ToLower(strings.TrimSpace(domain))
	}
	var rows pgx.Rows
	var err error
	if randomCount > 0 {
		rows, err = s.pool.Query(ctx, `
			SELECT c.id, c.archive_id, a.filename, c.entry_path, c.entry_name, c.domain, c.cookie_count, c.netscape_text, c.json_text
			FROM archive_cookie_domains c
			JOIN archives a ON a.id = c.archive_id
			WHERE c.domain = $1 AND a.status = 'indexed'
			ORDER BY random()
			LIMIT $2;
		`, domain, randomCount)
	} else {
		rows, err = s.pool.Query(ctx, `
			SELECT c.id, c.archive_id, a.filename, c.entry_path, c.entry_name, c.domain, c.cookie_count, c.netscape_text, c.json_text
			FROM archive_cookie_domains c
			JOIN archives a ON a.id = c.archive_id
			WHERE c.domain = $1 AND a.status = 'indexed'
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
