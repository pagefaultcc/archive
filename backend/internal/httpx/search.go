package httpx

import (
	"archive/backend/internal/archiveidx"
	"archive/backend/internal/store"
	"archive/zip"
	"context"
	"fmt"
	"io"
	"net/http"
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

	h.writeBatchedSearchResultsToZip(r.Context(), zw, results, nil)
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
		h.writeBatchedSearchResultsToZip(context.Background(), zw, results, func(processed int) {
			h.jobsMu.Lock()
			job.Processed = processed
			job.Percent = int(float64(job.Processed) / float64(job.Total) * 100)
			h.jobsMu.Unlock()
		})
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

func (h *archiveHandlers) writeBatchedSearchResultsToZip(
	ctx context.Context,
	zw *zip.Writer,
	results []store.ArchiveSearchResult,
	onProgress func(processed int),
) {
	var archiveOrder []string
	byArchive := make(map[string][]store.ArchiveSearchResult)
	for _, item := range results {
		if _, exists := byArchive[item.ArchiveID]; !exists {
			archiveOrder = append(archiveOrder, item.ArchiveID)
		}
		byArchive[item.ArchiveID] = append(byArchive[item.ArchiveID], item)
	}

	seenMembers := make(map[string]int)
	processed := 0

	writeMember := func(archiveFilename, itemPath string, r io.Reader) {
		relPath := strings.TrimPrefix(filepath.ToSlash(itemPath), "/")
		archName := strings.TrimSuffix(filepath.Base(archiveFilename), filepath.Ext(archiveFilename))
		memberName := fmt.Sprintf("%s/%s", archName, relPath)
		if count := seenMembers[memberName]; count > 0 {
			seenMembers[memberName]++
			dir, base := filepath.Split(memberName)
			memberName = fmt.Sprintf("%s%d_%s", dir, count, base)
		} else {
			seenMembers[memberName] = 1
		}
		if wEntry, cerr := zw.Create(memberName); cerr == nil {
			_, _ = io.Copy(wEntry, io.LimitReader(r, 50*1024*1024))
		}
	}

	for _, archiveID := range archiveOrder {
		group := byArchive[archiveID]
		rec, err := h.Store.GetArchiveForReindex(ctx, archiveID)
		if err != nil {
			processed += len(group)
			if onProgress != nil {
				onProgress(processed)
			}
			continue
		}
		activePath := h.syncNamedLink(rec.Filename, rec.StoragePath)
		cleanPw := strings.Trim(strings.TrimSpace(rec.ArchivePassword), "`'\"")

		// Fast path for unencrypted ZIP archives: open container once in memory
		if rec.Format == "zip" && cleanPw == "" && !rec.IsEncrypted {
			if zr, zerr := zip.OpenReader(activePath); zerr == nil {
				fileMap := make(map[string]*zip.File, len(zr.File))
				for _, f := range zr.File {
					if !f.FileInfo().IsDir() {
						fileMap[strings.ToLower(strings.TrimPrefix(filepath.ToSlash(f.Name), "/"))] = f
					}
				}
				for _, item := range group {
					key := strings.ToLower(strings.TrimPrefix(filepath.ToSlash(item.Path), "/"))
					if zf, ok := fileMap[key]; ok {
						if rc, oerr := zf.Open(); oerr == nil {
							writeMember(rec.Filename, item.Path, rc)
							_ = rc.Close()
						}
					}
					processed++
					if onProgress != nil {
						onProgress(processed)
					}
				}
				_ = zr.Close()
				continue
			}
		}

		// General path: extract all matched entries for this archive in one batch
		extractDir, terr := os.MkdirTemp("", "search-batch-*")
		if terr == nil {
			paths := make([]string, 0, len(group))
			for _, item := range group {
				paths = append(paths, item.Path)
			}
			_ = archiveidx.ExtractBatchToDir(ctx, activePath, rec.Format, rec.ArchivePassword, paths, extractDir)
			for _, item := range group {
				rel := strings.TrimPrefix(filepath.ToSlash(item.Path), "/")
				extractedFile := filepath.Join(extractDir, filepath.FromSlash(rel))
				if rf, oerr := os.Open(extractedFile); oerr == nil {
					writeMember(rec.Filename, item.Path, rf)
					_ = rf.Close()
				} else if data, _, rerr := archiveidx.ReadEntry(ctx, activePath, rec.Format, rec.ArchivePassword, item.Path, 50*1024*1024); rerr == nil && len(data) > 0 {
					writeMember(rec.Filename, item.Path, strings.NewReader(string(data)))
				}
				processed++
				if onProgress != nil {
					onProgress(processed)
				}
			}
			_ = os.RemoveAll(extractDir)
		} else {
			for _, item := range group {
				if data, _, rerr := archiveidx.ReadEntry(ctx, activePath, rec.Format, rec.ArchivePassword, item.Path, 50*1024*1024); rerr == nil && len(data) > 0 {
					writeMember(rec.Filename, item.Path, strings.NewReader(string(data)))
				}
				processed++
				if onProgress != nil {
					onProgress(processed)
				}
			}
		}
	}
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
