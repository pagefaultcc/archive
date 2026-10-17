package httpx

import (
	"archive/backend/internal/archiveidx"
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// filePreview handles GET /api/archives/{id}/file?path=
// Reads up to 512 KiB of the requested file in memory using the stored
// archive_password (never extracting to disk and never asking the viewer for a
// password).
func (h *archiveHandlers) filePreview(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	entryPath := strings.TrimSpace(strings.TrimPrefix(r.URL.Query().Get("path"), "/"))
	if entryPath == "" {
		WriteError(w, WithFields(map[string]string{"path": "File path is required."}))
		return
	}
	archiveFilename, storagePath, format, archivePassword, entry, err := h.Store.GetArchiveEntryForRead(
		r.Context(), r.PathValue("id"), entryPath,
	)
	if err != nil {
		h.writeArchiveStoreError(w, r, err)
		return
	}
	if entry.IsDir {
		WriteError(w, WithFields(map[string]string{"path": "Cannot preview a directory as a file."}))
		return
	}
	activePath := h.syncNamedLink(archiveFilename, storagePath)
	const maxPreviewBytes = 512 * 1024
	data, truncated, rerr := archiveidx.ReadEntry(
		r.Context(), activePath, format, archivePassword, entry.Path, maxPreviewBytes,
	)
	if rerr != nil {
		h.logInternal(r.Context(), "archive entry preview failed", rerr)
		if errors.Is(rerr, archiveidx.ErrInvalidPassword) {
			WriteError(w, InvalidArchivePassword)
			return
		}
		WriteError(w, &APIError{
			Status:  http.StatusUnprocessableEntity,
			Code:    "preview_failed",
			Message: rerr.Error(),
		})
		return
	}

	ext := strings.ToLower(filepath.Ext(entry.Name))
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}

	if strings.HasPrefix(mimeType, "image/") && len(data) > 0 {
		WriteJSON(w, http.StatusOK, map[string]any{
			"entry":      entry,
			"kind":       "image",
			"mimeType":   mimeType,
			"base64Data": base64.StdEncoding.EncodeToString(data),
			"truncated":  truncated,
		})
		return
	}

	if isTextContent(data, ext) {
		WriteJSON(w, http.StatusOK, map[string]any{
			"entry":     entry,
			"kind":      "text",
			"mimeType":  mimeType,
			"text":      string(data),
			"truncated": truncated,
		})
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"entry":      entry,
		"kind":       "binary",
		"mimeType":   mimeType,
		"hexPreview": formatHexDump(data, 4096),
		"truncated":  truncated,
	})
}

// downloadEntry handles GET /api/archives/{id}/download?path=&zip=1
// Extracts the requested folder (or file) into a temporary staging folder under
// /tmp/archive-downloads, packages folders (and zip=1 files) into a .zip,
// serves the download to the user, and deletes the staged files from /tmp
// after the TTL (5 minutes).
func (h *archiveHandlers) downloadEntry(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	entryPath := strings.TrimSpace(strings.TrimPrefix(r.URL.Query().Get("path"), "/"))
	if entryPath == "" {
		WriteError(w, WithFields(map[string]string{"path": "Entry path is required."}))
		return
	}
	asZip := r.URL.Query().Get("zip") == "1" || r.URL.Query().Get("zip") == "true"
	archiveFilename, storagePath, format, archivePassword, entry, err := h.Store.GetArchiveEntryForRead(
		r.Context(), r.PathValue("id"), entryPath,
	)
	if err != nil {
		h.writeArchiveStoreError(w, r, err)
		return
	}

	activePath := h.syncNamedLink(archiveFilename, storagePath)
	tmpRoot := filepath.Join(os.TempDir(), "archive-downloads")
	stagedPath, downloadName, serr := archiveidx.StageDownload(
		r.Context(),
		activePath,
		format,
		archivePassword,
		entry.Path,
		entry.IsDir,
		asZip,
		tmpRoot,
		5*time.Minute,
	)
	if serr != nil {
		h.logInternal(r.Context(), "archive entry download staging failed", serr)
		if errors.Is(serr, archiveidx.ErrInvalidPassword) {
			WriteError(w, InvalidArchivePassword)
			return
		}
		WriteError(w, &APIError{
			Status:  http.StatusUnprocessableEntity,
			Code:    "download_staging_failed",
			Message: serr.Error(),
		})
		return
	}

	f, oerr := os.Open(stagedPath)
	if oerr != nil {
		h.logInternal(r.Context(), "opening staged download failed", oerr)
		WriteError(w, InternalServerError)
		return
	}
	defer f.Close()
	stat, serr := f.Stat()
	if serr != nil {
		WriteError(w, InternalServerError)
		return
	}

	safeName := strings.ReplaceAll(downloadName, `"`, "")
	if entry.IsDir || asZip {
		w.Header().Set("Content-Type", "application/zip")
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, safeName))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Archive-Tmp-TTL", "300s")
	http.ServeContent(w, r, safeName, stat.ModTime(), f)
}

func isTextContent(data []byte, ext string) bool {
	if len(data) == 0 {
		return true
	}
	switch ext {
	case ".txt", ".md", ".json", ".yaml", ".yml", ".xml", ".csv", ".tsv", ".log",
		".sql", ".ini", ".cfg", ".conf", ".env", ".toml", ".sh", ".bat", ".ps1",
		".go", ".py", ".js", ".ts", ".tsx", ".jsx", ".css", ".html", ".c", ".cpp",
		".h", ".rs", ".java", ".rb", ".php":
		if utf8.Valid(data) {
			return true
		}
	}
	if !utf8.Valid(data) {
		return false
	}
	return !bytes.Contains(data, []byte{0})
}

func formatHexDump(data []byte, limit int) string {
	if len(data) > limit {
		data = data[:limit]
	}
	var sb strings.Builder
	for offset := 0; offset < len(data); offset += 16 {
		end := offset + 16
		if end > len(data) {
			end = len(data)
		}
		chunk := data[offset:end]
		fmt.Fprintf(&sb, "%08x  ", offset)
		for i := range 16 {
			if i < len(chunk) {
				fmt.Fprintf(&sb, "%02x ", chunk[i])
			} else {
				sb.WriteString("   ")
			}
			if i == 7 {
				sb.WriteByte(' ')
			}
		}
		sb.WriteString(" |")
		for _, b := range chunk {
			if b >= 32 && b <= 126 {
				sb.WriteByte(b)
			} else {
				sb.WriteByte('.')
			}
		}
		sb.WriteString("|\n")
	}
	return sb.String()
}
