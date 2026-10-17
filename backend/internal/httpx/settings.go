package httpx

import (
	"archive/backend/internal/archiveidx"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// storageStats handles GET /api/settings/storage
func (h *archiveHandlers) storageStats(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	stats, err := h.Store.GetGlobalStorageStats(r.Context(), h.StorageDir)
	if err != nil {
		h.logInternal(r.Context(), "storage stats calculation failed", err)
		WriteError(w, InternalServerError)
		return
	}

	// Get disk usage via syscall
	total, free, used := getDiskSpace(h.StorageDir)
	stats.DiskTotalBytes = total
	stats.DiskFreeBytes = free
	stats.DiskUsedBytes = used

	WriteJSON(w, http.StatusOK, stats)
}

// CleanTempFilesNow immediately deletes all temporary upload files, download staging
// directories, orphaned storage blobs not present in the database, and broken symlinks.
// Returns the total bytes freed and number of items removed.
func (h *archiveHandlers) CleanTempFilesNow(ctx context.Context) (freedBytes int64, removedCount int, err error) {
	cutoff := time.Now().Add(-15 * time.Minute)

	// 1. Clean temporary upload files older than 15 minutes in StorageDir and os.TempDir()/archive-uploads
	dirs := []string{h.StorageDir, filepath.Join(os.TempDir(), "archive-uploads")}
	for _, dir := range dirs {
		entries, rerr := os.ReadDir(dir)
		if rerr != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			isTemp := strings.HasPrefix(name, "upload-") ||
				strings.HasSuffix(name, ".tmp") ||
				strings.HasSuffix(name, ".partial")
			if !isTemp {
				continue
			}
			info, ierr := e.Info()
			if ierr != nil || info.IsDir() || info.ModTime().After(cutoff) {
				continue
			}
			size := info.Size()
			full := filepath.Join(dir, name)
			if os.Remove(full) == nil {
				freedBytes += size
				removedCount++
			}
		}
	}

	// 2. Clean staged downloads older than 15 minutes in os.TempDir()/archive-downloads
	dlRoot := filepath.Join(os.TempDir(), "archive-downloads")
	if dlEntries, rerr := os.ReadDir(dlRoot); rerr == nil {
		for _, e := range dlEntries {
			info, ierr := e.Info()
			if ierr != nil || info.ModTime().After(cutoff) {
				continue
			}
			full := filepath.Join(dlRoot, e.Name())
			var dirSize int64
			_ = filepath.Walk(full, func(_ string, fi os.FileInfo, err error) error {
				if err == nil && fi != nil && !fi.IsDir() {
					dirSize += fi.Size()
				}
				return nil
			})
			if os.RemoveAll(full) == nil {
				freedBytes += dirSize
				removedCount++
			}
		}
	}

	// 3. Clean orphaned archive blobs in StorageDir that have no database record and are older than 15 minutes
	dbArchives, derr := h.Store.GetAllArchivesForReindex(ctx)
	if derr == nil {
		validPaths := make(map[string]bool, len(dbArchives))
		for _, a := range dbArchives {
			validPaths[filepath.Clean(a.StoragePath)] = true
		}
		if entries, rerr := os.ReadDir(h.StorageDir); rerr == nil {
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				name := e.Name()
				if strings.HasPrefix(name, "tg-download-") || strings.HasPrefix(name, "upload-") {
					continue
				}
				info, ierr := e.Info()
				if ierr != nil || info.ModTime().After(cutoff) {
					continue
				}
				full := filepath.Clean(filepath.Join(h.StorageDir, name))
				if !validPaths[full] {
					size := info.Size()
					if os.Remove(full) == nil {
						freedBytes += size
						removedCount++
					}
				}
			}
		}
	}
	// 4. Clean dangling symlinks in by-name
	h.sweepNamedLinks()

	return freedBytes, removedCount, nil
}

// cleanupTemp handles POST /api/settings/cleanup-temp
func (h *archiveHandlers) cleanupTemp(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	freed, count, err := h.CleanTempFilesNow(r.Context())
	if err != nil {
		h.logInternal(r.Context(), "temp cleanup failed", err)
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"freedBytes":   freed,
		"removedCount": count,
	})
}

type updatePasswordsRequest struct {
	Passwords []string `json:"passwords"`
}

// getArchivePasswords handles GET /api/settings/passwords
func (h *archiveHandlers) getArchivePasswords(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	pws, err := h.Store.GetArchivePasswords(r.Context())
	if err != nil {
		h.logInternal(r.Context(), "loading archive passwords failed", err)
		WriteError(w, InternalServerError)
		return
	}
	if len(pws) == 0 {
		pws = archiveidx.DefaultPasswords()
	}
	WriteJSON(w, http.StatusOK, map[string]any{"passwords": pws})
}

// updateArchivePasswords handles PUT /api/settings/passwords
func (h *archiveHandlers) updateArchivePasswords(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req updatePasswordsRequest
	if apiErr := DecodeJSON(r, &req); apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	if err := h.Store.SetArchivePasswords(r.Context(), req.Passwords, actor.ID); err != nil {
		h.logInternal(r.Context(), "saving archive passwords failed", err)
		WriteError(w, InternalServerError)
		return
	}
	// Update in-memory dictionary immediately
	archiveidx.SetDefaultPasswords(req.Passwords)
	pws := archiveidx.DefaultPasswords()
	WriteJSON(w, http.StatusOK, map[string]any{"passwords": pws})
}
