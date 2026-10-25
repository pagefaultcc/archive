package httpx

import (
	"archive/backend/internal/archiveidx"
	"archive/backend/internal/store"
	"archive/zip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// reindexAllCookies triggers background cookie re-extraction across all archives.
func (h *archiveHandlers) reindexAllCookies(w http.ResponseWriter, r *http.Request) {
	if mustActor(r) == nil {
		WriteError(w, Unauthenticated)
		return
	}
	go func() {
		ctx := context.Background()
		archives, err := h.Store.GetAllArchivesForReindex(ctx)
		if err != nil {
			h.Log.Error("reindexAllCookies: failed to load archives", "error", err)
			return
		}
		for _, a := range archives {
			_ = h.syncNamedLink(a.Filename, a.StoragePath)
		}
		for i, a := range archives {
			activePath := h.syncNamedLink(a.Filename, a.StoragePath)
			res, err := h.Index(ctx, activePath, a.Format, a.ArchivePassword)
			if err != nil {
				h.Log.Error("reindexAllCookies: indexing failed", "filename", a.Filename, "error", err)
				continue
			}
			effectivePw := a.ArchivePassword
			if effectivePw == "" && res.MatchedPassword != "" {
				effectivePw = res.MatchedPassword
				_ = h.Store.SetArchivePassword(ctx, a.ID, effectivePw)
			}
			h.indexArchiveCookies(ctx, a.ID, activePath, a.Format, effectivePw, res.Entries)
			h.indexArchiveCredentials(ctx, a.ID, activePath, a.Format, effectivePw, res.Entries)
			h.indexArchiveCards(ctx, a.ID, activePath, a.Format, effectivePw, res.Entries)
			h.Log.Info("reindexAllCookies: completed archive", "index", i+1, "total", len(archives), "filename", a.Filename)
		}
	}()
	WriteJSON(w, http.StatusOK, map[string]any{"status": "started", "message": "Background cookie extraction started across all archives."})
}

// indexArchiveCookies extracts and parses Netscape & JSON cookie files by root domain.
func (h *archiveHandlers) indexArchiveCookies(
	ctx context.Context,
	archiveID, filePath, format, password string,
	entries []archiveidx.Entry,
) {
	bgCtx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	chunks := archiveidx.ExtractCookieDomains(bgCtx, filePath, format, password, entries)
	inputs := make([]store.CookieDomainInput, 0, len(chunks))
	for _, c := range chunks {
		inputs = append(inputs, store.CookieDomainInput{
			EntryPath:    c.EntryPath,
			EntryName:    c.EntryName,
			Domain:       c.Domain,
			CookieCount:  c.CookieCount,
			NetscapeText: c.NetscapeText,
			JSONText:     c.JSONText,
		})
	}
	if err := h.Store.SaveArchiveCookieDomains(bgCtx, archiveID, inputs); err != nil {
		h.logInternal(bgCtx, "saving archive cookie domains failed", err)
	}
}

// listCookies handles GET /api/cookies?q=&domain=
func (h *archiveHandlers) listCookies(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	selectedDomain := strings.TrimSpace(r.URL.Query().Get("domain"))

	if selectedDomain != "" {
		logs, err := h.Store.ListLogsForCookieDomain(r.Context(), selectedDomain, q, 250)
		if err != nil {
			h.logInternal(r.Context(), "listing cookie domain logs failed", err)
			WriteError(w, InternalServerError)
			return
		}
		WriteJSON(w, http.StatusOK, map[string]any{
			"domain": selectedDomain,
			"logs":   logs,
		})
		return
	}
	limit := 100
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if n, err := strconv.Atoi(lStr); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	offset := 0
	if oStr := r.URL.Query().Get("offset"); oStr != "" {
		if n, err := strconv.Atoi(oStr); err == nil && n >= 0 {
			offset = n
		}
	}

	domains, totalDomains, totalLogs, totalCookies, filteredCount, err := h.Store.ListCookieDomains(r.Context(), q, limit, offset)
	if err != nil {
		h.logInternal(r.Context(), "listing cookie domains failed", err)
		WriteError(w, InternalServerError)
		return
	}
	hasMore := (offset + len(domains)) < filteredCount

	WriteJSON(w, http.StatusOK, map[string]any{
		"domains":       domains,
		"totalDomains":  totalDomains,
		"totalLogs":     totalLogs,
		"totalCookies":  totalCookies,
		"filteredCount": filteredCount,
		"hasMore":       hasMore,
		"limit":         limit,
		"offset":        offset,
	})
}

// downloadCookies handles GET /api/cookies/download?domain=&count=&format=netscape|json
// Stages a .zip in /tmp/archive-downloads containing one separate stripped cookie file per log,
// serves it, and automatically deletes the temp file after 5 minutes.
func (h *archiveHandlers) downloadCookies(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	domain := strings.TrimSpace(r.URL.Query().Get("domain"))
	if domain == "" {
		WriteError(w, WithFields(map[string]string{"domain": "Domain is required."}))
		return
	}
	count := 0
	if cStr := strings.TrimSpace(r.URL.Query().Get("count")); cStr != "" {
		if n, err := strconv.Atoi(cStr); err == nil && n > 0 {
			count = n
		}
	}
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format != "json" {
		format = "netscape"
	}

	logs, err := h.Store.GetCookieLogsForDownload(r.Context(), domain, count)
	if err != nil {
		h.logInternal(r.Context(), "loading cookie logs for download failed", err)
		WriteError(w, InternalServerError)
		return
	}
	if len(logs) == 0 {
		WriteError(w, NotFound)
		return
	}

	dlRoot := filepath.Join(os.TempDir(), "archive-downloads")
	_ = os.MkdirAll(dlRoot, 0o755)
	jobDir, err := os.MkdirTemp(dlRoot, "cookies-dl-*")
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	time.AfterFunc(5*time.Minute, func() {
		_ = os.RemoveAll(jobDir)
	})

	ext := ".txt"
	if format == "json" {
		ext = ".json"
	}
	zipName := fmt.Sprintf("%s-%d-logs-%s.zip", domain, len(logs), format)
	zipPath := filepath.Join(jobDir, zipName)

	zf, err := os.Create(zipPath)
	if err != nil {
		_ = os.RemoveAll(jobDir)
		WriteError(w, InternalServerError)
		return
	}
	zw := zip.NewWriter(zf)
	for idx, item := range logs {
		// Extract the log folder identifier from entryPath for descriptive naming
		folderTag := "log"
		parts := strings.Split(item.EntryPath, "/")
		if len(parts) >= 2 {
			folderTag = parts[len(parts)-2]
			if strings.EqualFold(folderTag, "cookies") && len(parts) >= 3 {
				folderTag = parts[len(parts)-3]
			}
		}
		safeTag := strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
				return r
			}
			return '_'
		}, folderTag)
		if len(safeTag) > 48 {
			safeTag = safeTag[:48]
		}
		memberName := fmt.Sprintf("%03d_%s_%s%s", idx+1, domain, safeTag, ext)
		wEntry, cerr := zw.Create(memberName)
		if cerr != nil {
			continue
		}
		if format == "json" {
			_, _ = io.WriteString(wEntry, item.JSONText)
		} else {
			header := fmt.Sprintf("# Netscape HTTP Cookie File\n# Domain: %s\n# Source Archive: %s\n# Source Path: %s\n\n",
				domain, item.ArchiveFilename, item.EntryPath)
			_, _ = io.WriteString(wEntry, header+item.NetscapeText+"\n")
		}
	}
	_ = zw.Close()
	_ = zf.Close()

	f, oerr := os.Open(zipPath)
	if oerr != nil {
		WriteError(w, InternalServerError)
		return
	}
	defer f.Close()
	stat, serr := f.Stat()
	if serr != nil {
		WriteError(w, InternalServerError)
		return
	}

	safeZipName := strings.ReplaceAll(zipName, `"`, "")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, safeZipName))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Archive-Tmp-TTL", "300s")
	http.ServeContent(w, r, safeZipName, stat.ModTime(), f)
}
