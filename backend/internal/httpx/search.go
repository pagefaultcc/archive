package httpx

import (
	"archive/backend/internal/archiveidx"
	"archive/backend/internal/store"
	"archive/zip"
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type searchDownloadJob struct {
	ID        string    `json:"id"`
	Total     int       `json:"total"`
	Processed int       `json:"processed"`
	Percent   int       `json:"percent"`
	Status    string    `json:"status"` // "preparing", "ready", "error"
	Error     string    `json:"error,omitempty"`
	ZipPath   string    `json:"-"`
	ZipName   string    `json:"zipName"`
	CreatedAt time.Time `json:"-"`
}

// searchEntries handles GET /api/search?q=&name=&type=&minSize=&maxSize=&archive=&regex=
func (h *archiveHandlers) searchEntries(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}

	q := r.URL.Query()
	var f store.SearchFilters
	f.Query = strings.TrimSpace(q.Get("q"))
	f.FileName = strings.TrimSpace(q.Get("name"))
	f.FileType = strings.TrimSpace(q.Get("type"))
	f.ArchiveID = strings.TrimSpace(q.Get("archive"))
	f.IsRegex = q.Get("regex") == "1" || q.Get("regex") == "true"
	f.IsExact = q.Get("exact") == "1" || q.Get("exact") == "true"
	if minStr := strings.TrimSpace(q.Get("minSize")); minStr != "" {
		if n, err := strconv.ParseInt(minStr, 10, 64); err == nil && n >= 0 {
			f.MinSizeBytes = n
		}
	}
	if maxStr := strings.TrimSpace(q.Get("maxSize")); maxStr != "" {
		if n, err := strconv.ParseInt(maxStr, 10, 64); err == nil && n >= 0 {
			f.MaxSizeBytes = n
		}
	}
	f.Limit = 100
	if limStr := strings.TrimSpace(q.Get("limit")); limStr != "" {
		if n, err := strconv.Atoi(limStr); err == nil && n > 0 {
			f.Limit = n
		}
	}
	if offStr := strings.TrimSpace(q.Get("offset")); offStr != "" {
		if n, err := strconv.Atoi(offStr); err == nil && n >= 0 {
			f.Offset = n
		}
	}

	results, totalCount, err := h.Store.SearchArchiveEntries(r.Context(), f)
	if err != nil {
		h.logInternal(r.Context(), "search failed", err)
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "search_error",
			Message: fmt.Sprintf("Search failed: %v", err),
		})
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"results":    results,
		"totalCount": totalCount,
		"limit":      f.Limit,
		"offset":     f.Offset,
	})
}

// downloadSearchResults handles GET /api/search/download?q=&name=&type=&minSize=&maxSize=&archive=&regex=&exact=&limit=
func (h *archiveHandlers) downloadSearchResults(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}

	q := r.URL.Query()
	var f store.SearchFilters
	f.Query = strings.TrimSpace(q.Get("q"))
	f.FileName = strings.TrimSpace(q.Get("name"))
	f.FileType = strings.TrimSpace(q.Get("type"))
	f.ArchiveID = strings.TrimSpace(q.Get("archive"))
	f.IsRegex = q.Get("regex") == "1" || q.Get("regex") == "true"
	f.IsExact = q.Get("exact") == "1" || q.Get("exact") == "true"

	if minStr := strings.TrimSpace(q.Get("minSize")); minStr != "" {
		if n, err := strconv.ParseInt(minStr, 10, 64); err == nil && n >= 0 {
			f.MinSizeBytes = n
		}
	}
	if maxStr := strings.TrimSpace(q.Get("maxSize")); maxStr != "" {
		if n, err := strconv.ParseInt(maxStr, 10, 64); err == nil && n >= 0 {
			f.MaxSizeBytes = n
		}
	}
	f.Limit = 5000
	if limStr := strings.TrimSpace(q.Get("limit")); limStr != "" {
		if n, err := strconv.Atoi(limStr); err == nil && n > 0 && n <= 10000 {
			f.Limit = n
		}
	}
	f.Offset = 0

	results, _, err := h.Store.SearchArchiveEntries(r.Context(), f)
	if err != nil {
		h.logInternal(r.Context(), "search download failed", err)
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "search_error",
			Message: fmt.Sprintf("Search failed: %v", err),
		})
		return
	}
	if len(results) == 0 {
		WriteError(w, NotFound)
		return
	}

	dlRoot := filepath.Join(os.TempDir(), "archive-downloads")
	_ = os.MkdirAll(dlRoot, 0o755)
	jobDir, err := os.MkdirTemp(dlRoot, "search-dl-*")
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	time.AfterFunc(5*time.Minute, func() {
		_ = os.RemoveAll(jobDir)
	})

	zipName := fmt.Sprintf("search-results-%d-files.zip", len(results))
	zipPath := filepath.Join(jobDir, zipName)
	zf, err := os.Create(zipPath)
	if err != nil {
		_ = os.RemoveAll(jobDir)
		WriteError(w, InternalServerError)
		return
	}
	zw := zip.NewWriter(zf)

	seenMembers := make(map[string]int)
	for _, item := range results {
		archiveFilename, storagePath, format, archivePassword, _, err := h.Store.GetArchiveEntryForRead(r.Context(), item.ArchiveID, item.Path)
		if err != nil {
			continue
		}
		activePath := h.syncNamedLink(archiveFilename, storagePath)
		data, _, err := archiveidx.ReadEntry(r.Context(), activePath, format, archivePassword, item.Path, 50*1024*1024)
		if err != nil || len(data) == 0 {
			continue
		}

		relPath := strings.TrimPrefix(filepath.ToSlash(item.Path), "/")
		archName := strings.TrimSuffix(filepath.Base(item.ArchiveFilename), filepath.Ext(item.ArchiveFilename))
		memberName := fmt.Sprintf("%s/%s", archName, relPath)
		if count := seenMembers[memberName]; count > 0 {
			seenMembers[memberName]++
			dir, base := filepath.Split(memberName)
			memberName = fmt.Sprintf("%s%d_%s", dir, count, base)
		} else {
			seenMembers[memberName] = 1
		}

		wEntry, cerr := zw.Create(memberName)
		if cerr != nil {
			continue
		}
		_, _ = wEntry.Write(data)
	}
	_ = zw.Close()
	_ = zf.Close()

	fFile, oerr := os.Open(zipPath)
	if oerr != nil {
		WriteError(w, InternalServerError)
		return
	}
	defer fFile.Close()
	stat, serr := fFile.Stat()
	if serr != nil {
		WriteError(w, InternalServerError)
		return
	}

	safeZipName := strings.ReplaceAll(zipName, `"`, "")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, safeZipName))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Archive-Tmp-TTL", "300s")
	http.ServeContent(w, r, safeZipName, stat.ModTime(), fFile)
}

// prepareSearchDownload handles POST /api/search/prepare-download
// Starts a background job that batches file extraction, computes progress, and creates the zip.
func (h *archiveHandlers) prepareSearchDownload(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	q := r.URL.Query()
	var f store.SearchFilters
	f.Query = strings.TrimSpace(q.Get("q"))
	f.FileName = strings.TrimSpace(q.Get("name"))
	f.FileType = strings.TrimSpace(q.Get("type"))
	f.ArchiveID = strings.TrimSpace(q.Get("archive"))
	f.IsRegex = q.Get("regex") == "1" || q.Get("regex") == "true"
	f.IsExact = q.Get("exact") == "1" || q.Get("exact") == "true"

	f.Limit = 5000
	if limStr := strings.TrimSpace(q.Get("limit")); limStr != "" {
		if n, err := strconv.Atoi(limStr); err == nil && n > 0 && n <= 10000 {
			f.Limit = n
		}
	}

	results, _, err := h.Store.SearchArchiveEntries(r.Context(), f)
	if err != nil {
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "search_error",
			Message: fmt.Sprintf("Search failed: %v", err),
		})
		return
	}
	if len(results) == 0 {
		WriteError(w, NotFound)
		return
	}

	jobID := fmt.Sprintf("job_%d", time.Now().UnixNano())
	zipName := fmt.Sprintf("search-results-%d-files.zip", len(results))
	job := &searchDownloadJob{
		ID:        jobID,
		Total:     len(results),
		Processed: 0,
		Percent:   0,
		Status:    "preparing",
		ZipName:   zipName,
		CreatedAt: time.Now(),
	}

	h.jobsMu.Lock()
	h.jobs[jobID] = job
	h.jobsMu.Unlock()

	// Run background packaging goroutine
	go func() {
		dlRoot := filepath.Join(os.TempDir(), "archive-downloads")
		_ = os.MkdirAll(dlRoot, 0o755)
		jobDir, err := os.MkdirTemp(dlRoot, "search-job-*")
		if err != nil {
			h.jobsMu.Lock()
			job.Status = "error"
			job.Error = err.Error()
			h.jobsMu.Unlock()
			return
		}
		zipPath := filepath.Join(jobDir, zipName)
		zf, err := os.Create(zipPath)
		if err != nil {
			_ = os.RemoveAll(jobDir)
			h.jobsMu.Lock()
			job.Status = "error"
			job.Error = err.Error()
			h.jobsMu.Unlock()
			return
		}
		zw := zip.NewWriter(zf)
		seenMembers := make(map[string]int)

		for idx, item := range results {
			archiveFilename, storagePath, format, archivePassword, _, err := h.Store.GetArchiveEntryForRead(context.Background(), item.ArchiveID, item.Path)
			if err == nil {
				activePath := h.syncNamedLink(archiveFilename, storagePath)
				data, _, rerr := archiveidx.ReadEntry(context.Background(), activePath, format, archivePassword, item.Path, 50*1024*1024)
				if rerr == nil && len(data) > 0 {
					relPath := strings.TrimPrefix(filepath.ToSlash(item.Path), "/")
					archName := strings.TrimSuffix(filepath.Base(item.ArchiveFilename), filepath.Ext(item.ArchiveFilename))
					memberName := fmt.Sprintf("%s/%s", archName, relPath)
					if count := seenMembers[memberName]; count > 0 {
						seenMembers[memberName]++
						dir, base := filepath.Split(memberName)
						memberName = fmt.Sprintf("%s%d_%s", dir, count, base)
					} else {
						seenMembers[memberName] = 1
					}
					wEntry, cerr := zw.Create(memberName)
					if cerr == nil {
						_, _ = wEntry.Write(data)
					}
				}
			}
			h.jobsMu.Lock()
			job.Processed = idx + 1
			job.Percent = int(float64(job.Processed) / float64(job.Total) * 100)
			h.jobsMu.Unlock()
		}
		_ = zw.Close()
		_ = zf.Close()

		time.AfterFunc(10*time.Minute, func() {
			_ = os.RemoveAll(jobDir)
			h.jobsMu.Lock()
			delete(h.jobs, jobID)
			h.jobsMu.Unlock()
		})

		h.jobsMu.Lock()
		job.ZipPath = zipPath
		job.Status = "ready"
		job.Percent = 100
		h.jobsMu.Unlock()
	}()

	WriteJSON(w, http.StatusAccepted, map[string]any{
		"jobId": jobID,
		"total": job.Total,
	})
}

// getSearchDownloadJob handles GET /api/search/download-job/{id}
func (h *archiveHandlers) getSearchDownloadJob(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	id := r.PathValue("id")
	h.jobsMu.RLock()
	job, ok := h.jobs[id]
	h.jobsMu.RUnlock()

	if !ok {
		WriteError(w, NotFound)
		return
	}
	res := map[string]any{
		"id":        job.ID,
		"status":    job.Status,
		"total":     job.Total,
		"processed": job.Processed,
		"percent":   job.Percent,
		"zipName":   job.ZipName,
	}
	if job.Status == "ready" {
		res["downloadUrl"] = fmt.Sprintf("/api/search/download-job/%s/file", job.ID)
	}
	if job.Error != "" {
		res["error"] = job.Error
	}
	WriteJSON(w, http.StatusOK, res)
}

// serveSearchDownloadFile handles GET /api/search/download-job/{id}/file
func (h *archiveHandlers) serveSearchDownloadFile(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	id := r.PathValue("id")
	h.jobsMu.RLock()
	job, ok := h.jobs[id]
	h.jobsMu.RUnlock()

	if !ok || job.Status != "ready" || job.ZipPath == "" {
		WriteError(w, NotFound)
		return
	}

	fFile, err := os.Open(job.ZipPath)
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	defer fFile.Close()
	stat, err := fFile.Stat()
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}

	safeZipName := strings.ReplaceAll(job.ZipName, `"`, "")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, safeZipName))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, safeZipName, stat.ModTime(), fFile)
}
