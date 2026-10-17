package httpx

import (
	"archive/backend/internal/archiveidx"
	"archive/backend/internal/store"
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// indexArchiveCredentials extracts and parses stealer-log password files by URL.
func (h *archiveHandlers) indexArchiveCredentials(
	ctx context.Context,
	archiveID, filePath, format, password string,
	entries []archiveidx.Entry,
) {
	bgCtx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	chunks := archiveidx.ExtractCredentials(bgCtx, filePath, format, password, entries)
	inputs := make([]store.CredentialInput, 0, len(chunks))
	for _, c := range chunks {
		inputs = append(inputs, store.CredentialInput{
			EntryPath: c.EntryPath,
			EntryName: c.EntryName,
			URL:       c.URL,
			Domain:    c.Domain,
			Login:     c.Login,
			Password:  c.Password,
		})
	}
	if err := h.Store.SaveArchiveCredentials(bgCtx, archiveID, inputs); err != nil {
		h.logInternal(bgCtx, "saving archive credentials failed", err)
	}
}

// listPasswords handles GET /api/passwords?q=&limit=&offset=
func (h *archiveHandlers) listPasswords(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
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

	results, totalCount, err := h.Store.SearchCredentials(r.Context(), q, limit, offset)
	if err != nil {
		h.logInternal(r.Context(), "searching credentials failed", err)
		WriteError(w, InternalServerError)
		return
	}
	hasMore := (int64(offset) + int64(len(results))) < totalCount

	WriteJSON(w, http.StatusOK, map[string]any{
		"results":    results,
		"totalCount": totalCount,
		"limit":      limit,
		"offset":     offset,
		"hasMore":    hasMore,
	})
}
