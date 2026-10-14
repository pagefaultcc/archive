package httpx

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
	"archive/backend/internal/archiveidx"
	"archive/backend/internal/store"
)

// maxArchiveBytes is the 100 GiB upload limit.
const maxArchiveBytes = 100 << 30
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

// archiveHandlers implements upload, list, detail, unlock, and delete.
type archiveHandlers struct {
	Store      *store.Store
	Log        *slog.Logger
	StorageDir string
	Index      func(ctx context.Context, filePath, format, password string) (archiveidx.Result, error)
	jobsMu     sync.RWMutex
	jobs       map[string]*searchDownloadJob
}
// tempFileMaxAge is how long an orphaned temp/partial upload file may sit
// before the background sweep removes it.
const tempFileMaxAge = 30 * time.Minute

// sweepInterval is the period between orphaned-temp-file sweeps.
const sweepInterval = 10 * time.Minute

// sweepOrphans removes abandoned upload temp files (*.tmp, *.partial, and the
// "upload-*" CreateTemp prefix) older than tempFileMaxAge from the given
// directories, and removes broken or dangling symlinks from by-name dirs.
func (h *archiveHandlers) sweepOrphans() {
	dirs := []string{h.StorageDir, filepath.Join(os.TempDir(), "archive-uploads")}
	cutoff := time.Now().Add(-tempFileMaxAge)
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if !os.IsNotExist(err) {
				h.Log.Warn("archive temp sweep read failed", "dir", dir, "error", err.Error())
			}
			continue
		}
		for _, e := range entries {
			name := e.Name()
			isTemp := strings.HasPrefix(name, "upload-") ||
				strings.HasSuffix(name, ".tmp") || strings.HasSuffix(name, ".partial")
			if !isTemp {
				continue
			}
			info, err := e.Info()
			if err != nil || info.IsDir() {
				continue
			}
			if info.ModTime().After(cutoff) {
				continue
			}
			if err := os.Remove(filepath.Join(dir, name)); err != nil && !os.IsNotExist(err) {
				h.Log.Warn("archive temp sweep removal failed", "path", filepath.Join(dir, name), "error", err.Error())
			} else {
				h.Log.Info("archive temp sweep removed orphaned file", "path", filepath.Join(dir, name))
			}
		}
	}
	h.sweepNamedLinks()
}

// sweepNamedLinks removes broken or dangling symlinks from the by-name
// directory (the files they pointed at no longer exist).
func (h *archiveHandlers) sweepNamedLinks() {
	dir := h.byNameDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		if e.Type()&os.ModeSymlink == 0 {
			continue
		}
		if _, err := os.Stat(path); os.IsNotExist(err) {
			_ = os.Remove(path)
		}
	}
}

// startSweeper runs one immediate sweep and then periodic sweeps until the
// context is cancelled, cleaning up files left behind by crashed or aborted
// uploads and downloads.
func (h *archiveHandlers) startSweeper(ctx context.Context) {
	go func() {
		if h.Store != nil {
			h.Store.InvalidateCookieCache()
		}
		h.sweepOrphans()
		ticker := time.NewTicker(sweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.sweepOrphans()
			}
		}
	}()
}

// newArchiveHandlers resolves the storage directory from ARCHIVE_STORAGE_DIR
// (default os.TempDir()+"/archive-uploads") and creates it.
func newArchiveHandlers(st *store.Store, log *slog.Logger) *archiveHandlers {
	dir := os.Getenv("ARCHIVE_STORAGE_DIR")
	if dir == "" {
		dir = filepath.Join(os.TempDir(), "archive-uploads")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Error("archive storage dir creation failed", "error", err.Error())
	}
	h := &archiveHandlers{
		Store:      st,
		Log:        log,
		StorageDir: dir,
		Index:      archiveidx.IndexFile,
		jobs:       make(map[string]*searchDownloadJob),
	}
	if st != nil {
		if pws, err := st.GetArchivePasswords(context.Background()); err == nil && len(pws) > 0 {
			archiveidx.SetDefaultPasswords(pws)
		}
	}
	return h
}

func (h *archiveHandlers) byNameDir() string {
	dir := filepath.Join(h.StorageDir, "by-name")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func (h *archiveHandlers) syncNamedLink(filename, storagePath string) string {
	if filename == "" || storagePath == "" {
		return storagePath
	}
	byName := h.byNameDir()
	safeName := filepath.Base(filepath.FromSlash(filename))
	linkPath := filepath.Join(byName, safeName)
	_ = os.Remove(linkPath)
	// Try symlink first, fall back to hard link if symlinks not supported
	if err := os.Symlink(storagePath, linkPath); err != nil {
		if err := os.Link(storagePath, linkPath); err != nil {
			return storagePath
		}
	}
	return linkPath
}

func (h *archiveHandlers) removeNamedLink(filename string) {
	if filename == "" {
		return
	}
	safeName := filepath.Base(filepath.FromSlash(filename))
	_ = os.Remove(filepath.Join(h.byNameDir(), safeName))
}

type archivesResponse struct {
	Archives []store.ArchiveItem `json:"archives"`
}

// list handles GET /api/archives.
func (h *archiveHandlers) list(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	items, err := h.Store.ListArchives(r.Context())
	if err != nil {
		h.logInternal(r.Context(), "archive list failed", err)
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusOK, archivesResponse{Archives: items})
}

// get handles GET /api/archives/{id}?parent=&q=.
func (h *archiveHandlers) get(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	parent := r.URL.Query().Get("parent")
	query := r.URL.Query().Get("q")
	detail, err := h.Store.GetArchiveDetail(r.Context(), r.PathValue("id"), parent, query)
	if err != nil {
		h.writeArchiveStoreError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, detail)
}

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

type unlockRequest struct {
	Password string `json:"password"`
}

// unlock handles POST /api/archives/{id}/unlock.
func (h *archiveHandlers) unlock(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	var req unlockRequest
	if apiErr := DecodeJSON(r, &req); apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	if req.Password == "" {
		WriteError(w, InvalidArchivePassword)
		return
	}
	id := r.PathValue("id")
	storagePath, format, status, err := h.Store.GetArchiveForUnlock(r.Context(), id)
	if err != nil {
		h.writeArchiveStoreError(w, r, err)
		return
	}
	if status != "password_required" {
		WriteError(w, InvalidArchiveFormat)
		return
	}
	if _, err := os.Stat(storagePath); err != nil {
		h.logInternal(r.Context(), "archive file missing", err)
		WriteError(w, NotFound)
		return
	}
	res, ierr := h.Index(r.Context(), storagePath, format, req.Password)
	if ierr != nil {
		if errors.Is(ierr, archiveidx.ErrInvalidPassword) {
			WriteError(w, InvalidArchivePassword)
			return
		}
		h.logInternal(r.Context(), "archive unlock indexing failed", ierr)
		WriteError(w, InternalServerError)
		return
	}
	item, err := h.Store.UnlockArchive(r.Context(), id, actor.ID, req.Password, storeEntryInputs(res))
	if err != nil {
		h.logInternal(r.Context(), "archive unlock persist failed", err)
		WriteError(w, InternalServerError)
		return
	}
	h.indexArchiveCookies(r.Context(), id, storagePath, format, req.Password, res.Entries)
	WriteJSON(w, http.StatusOK, map[string]store.ArchiveItem{"archive": item})
}

// delete handles DELETE /api/archives/{id}.
func (h *archiveHandlers) delete(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	id := r.PathValue("id")
	item, err := h.Store.GetArchive(r.Context(), id)
	if err != nil {
		h.writeArchiveStoreError(w, r, err)
		return
	}
	if item.OwnerID != actor.ID {
		allowed, err := h.Store.HasPermission(r.Context(), actor.ID, "archives:delete")
		if err != nil {
			h.logInternal(r.Context(), "permission check failed", err)
			WriteError(w, InternalServerError)
			return
		}
		if !allowed {
			allowed, err = h.Store.HasPermission(r.Context(), actor.ID, "users:delete")
			if err != nil {
				h.logInternal(r.Context(), "permission check failed", err)
				WriteError(w, InternalServerError)
				return
			}
			if !allowed {
				WriteError(w, Forbidden)
				return
			}
		}
	}
	h.removeNamedLink(item.Filename)
	_ = h.Store.MarkArchiveDeleting(r.Context(), id)

	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		storagePath, err := h.Store.DeleteArchive(bgCtx, id, actor.ID)
		if err != nil {
			h.Log.Error("background archive delete failed", "archive_id", id, "error", err.Error())
			return
		}
		if storagePath != "" {
			_ = os.Remove(storagePath)
		}
	}()

	WriteNoContent(w)
}

// upload handles POST /api/archives (multipart/form-data).
func (h *archiveHandlers) upload(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	// Disable the short JSON ReadTimeout/WriteTimeout so uploads up to 10 GiB
	// can stream without premature deadline termination.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	r.Body = http.MaxBytesReader(w, r.Body, maxArchiveBytes+(1<<20))
	mr, err := r.MultipartReader()
	if err != nil {
		WriteError(w, WithFields(map[string]string{"file": "A multipart form with a file field is required."}))
		return
	}

	if err := os.MkdirAll(h.StorageDir, 0o755); err != nil {
		h.logInternal(r.Context(), "storage dir creation failed", err)
		WriteError(w, InternalServerError)
		return
	}

	var (
		filename string
		password string
		tmpName  string
		size     int64
		sha      string
		head     []byte
		gotFile  bool
	)
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()

	for {
		part, perr := mr.NextPart()
		if perr == io.EOF {
			break
		}
		if perr != nil {
			if isTooLarge(perr) {
				WriteError(w, BodyTooLarge)
				return
			}
			WriteError(w, WithFields(map[string]string{"file": "A multipart form with a file field is required."}))
			return
		}
		formName := part.FormName()
		switch formName {
		case "password":
			pwBytes, rerr := io.ReadAll(io.LimitReader(part, 1024))
			_ = part.Close()
			if rerr != nil {
				WriteError(w, InvalidRequest)
				return
			}
			password = string(pwBytes)
		case "file":
			if gotFile {
				_ = part.Close()
				continue
			}
			gotFile = true
			filename = filepath.Base(strings.TrimSpace(part.FileName()))
			tmp, cerr := os.CreateTemp(h.StorageDir, "upload-*")
			if cerr != nil {
				_ = part.Close()
				h.logInternal(r.Context(), "temp file creation failed", cerr)
				WriteError(w, InternalServerError)
				return
			}
			tmpName = tmp.Name()
			hasher := sha256.New()
			head = make([]byte, 8)
			headN := 0
			buf := make([]byte, 1024*1024)
			var streamErr error
			for {
				n, rerr := part.Read(buf)
				if n > 0 {
					chunk := buf[:n]
					if headN < len(head) {
						copied := copy(head[headN:], chunk)
						headN += copied
					}
					if _, werr := hasher.Write(chunk); werr != nil {
						streamErr = werr
						break
					}
					if _, werr := tmp.Write(chunk); werr != nil {
						streamErr = werr
						break
					}
					size += int64(n)
					if size > maxArchiveBytes {
						streamErr = ErrBodyTooLarge
						break
					}
				}
				if rerr == io.EOF {
					break
				}
				if rerr != nil {
					streamErr = rerr
					break
				}
			}
			_ = tmp.Close()
			_ = part.Close()
			if streamErr != nil {
				if isTooLarge(streamErr) || errors.Is(streamErr, ErrBodyTooLarge) {
					WriteError(w, BodyTooLarge)
					return
				}
				h.logInternal(r.Context(), "archive upload read failed", streamErr)
				WriteError(w, InternalServerError)
				return
			}
			head = head[:headN]
			sha = hex.EncodeToString(hasher.Sum(nil))
		default:
			_ = part.Close()
		}
	}

	if !gotFile {
		WriteError(w, WithFields(map[string]string{"file": "A file is required."}))
		return
	}

	format, derr := archiveidx.DetectFormat(filename, head)
	if derr != nil || size == 0 {
		WriteError(w, InvalidArchiveFormat)
		return
	}

	// Persist under the final storage path: sha256 + extension.
	ext := strings.ToLower(filepath.Ext(filename))
	existing, found, err := h.Store.GetArchiveBySHA256(r.Context(), sha)
	if err != nil {
		h.logInternal(r.Context(), "checking duplicate archive sha256 failed", err)
		WriteError(w, InternalServerError)
		return
	}
	if found {
		WriteError(w, &APIError{
			Status:  http.StatusConflict,
			Code:    "archive_already_exists",
			Message: fmt.Sprintf("This exact archive has already been uploaded (\"%s\"). Duplicate uploads are prevented.", existing.Filename),
		})
		return
	}
	storagePath := filepath.Join(h.StorageDir, sha+ext)
	if err := os.Rename(tmpName, storagePath); err != nil {
		// Windows cannot rename over an existing file; replace it first.
		if err := os.Remove(storagePath); err == nil {
			if err := os.Rename(tmpName, storagePath); err != nil {
				h.logInternal(r.Context(), "archive persist failed", err)
				WriteError(w, InternalServerError)
				return
			}
		} else {
			h.logInternal(r.Context(), "archive persist failed", err)
			WriteError(w, InternalServerError)
			return
		}
	}
	// From here the final file owns cleanup; the temp-file defer is a no-op.

	activePath := h.syncNamedLink(filename, storagePath)
	res, ierr := h.Index(r.Context(), activePath, format, password)
	if ierr != nil {
		if errors.Is(ierr, archiveidx.ErrInvalidPassword) {
			item, serr := h.Store.CreateArchive(r.Context(), store.CreateArchiveInput{
				OwnerID: actor.ID, Filename: filename, Format: format,
				SizeBytes: size, SHA256: sha, IsEncrypted: true,
				Status: "password_required", StoragePath: storagePath,
			})
			if serr != nil {
				h.logInternal(r.Context(), "archive insert failed", serr)
				_ = os.Remove(storagePath)
				WriteError(w, InternalServerError)
				return
			}
			WriteJSON(w, http.StatusCreated, map[string]any{
				"archive":          item,
				"passwordRequired": true,
			})
			return
		}
		h.logInternal(r.Context(), "archive indexing failed", ierr)
		_ = os.Remove(storagePath)
		WriteError(w, InternalServerError)
		return
	}

	if res.PasswordRequired {
		item, serr := h.Store.CreateArchive(r.Context(), store.CreateArchiveInput{
			OwnerID: actor.ID, Filename: filename, Format: format,
			SizeBytes: size, SHA256: sha, IsEncrypted: true,
			Status: "password_required", StoragePath: storagePath,
		})
		if serr != nil {
			h.logInternal(r.Context(), "archive insert failed", serr)
			_ = os.Remove(storagePath)
			WriteError(w, InternalServerError)
			return
		}
		WriteJSON(w, http.StatusCreated, map[string]any{
			"archive":          item,
			"passwordRequired": true,
		})
		return
	}

	savedPassword := password
	if savedPassword == "" && res.MatchedPassword != "" {
		savedPassword = res.MatchedPassword
	}

	item, serr := h.Store.CreateArchive(r.Context(), store.CreateArchiveInput{
		OwnerID: actor.ID, Filename: filename, Format: format,
		SizeBytes: size, SHA256: sha, IsEncrypted: res.IsEncrypted,
		ArchivePassword: savedPassword, Status: "indexed", StoragePath: storagePath,
		Entries: storeEntryInputs(res),
	})
	if serr != nil {
		h.logInternal(r.Context(), "archive insert failed", serr)
		_ = os.Remove(storagePath)
		WriteError(w, InternalServerError)
		return
	}
	h.indexArchiveCookies(r.Context(), item.ID, activePath, format, savedPassword, res.Entries)
	WriteJSON(w, http.StatusCreated, map[string]any{
		"archive":      item,
		"autoUnlocked": res.MatchedPassword != "",
	})
}

// storeEntryInputs converts indexer results into store inputs.
func storeEntryInputs(res archiveidx.Result) []store.EntryInput {
	entries := make([]store.EntryInput, 0, len(res.Entries))
	for _, e := range res.Entries {
		entries = append(entries, store.EntryInput{
			Path: e.Path, ParentPath: e.ParentPath, Name: e.Name, IsDir: e.IsDir,
			SizeBytes: e.SizeBytes, PackedBytes: e.PackedBytes, CRC32: e.CRC32,
			Encrypted: e.Encrypted, ModifiedAt: e.ModifiedAt,
		})
	}
	return entries
}

func (h *archiveHandlers) writeArchiveStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		WriteError(w, NotFound)
	default:
		h.logInternal(r.Context(), "archive store error", err)
		WriteError(w, InternalServerError)
	}
}

func (h *archiveHandlers) logInternal(ctx context.Context, msg string, err error) {
	h.Log.Error(msg, "request_id", RequestID(ctx), "error", err.Error())
}

func isTooLarge(err error) bool {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return true
	}
	return err != nil && strings.Contains(err.Error(), "request body too large")
}

// reindexAll handles POST /api/archives/reindex
func (h *archiveHandlers) reindexAll(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}

	archives, err := h.Store.GetAllArchivesForReindex(r.Context())
	if err != nil {
		h.logInternal(r.Context(), "getting archives for reindex failed", err)
		WriteError(w, InternalServerError)
		return
	}

	reindexed := 0
	var errs []string
	for _, a := range archives {
		activePath := h.syncNamedLink(a.Filename, a.StoragePath)
		res, err := h.Index(r.Context(), activePath, a.Format, a.ArchivePassword)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", a.Filename, err))
			continue
		}
		status := "indexed"
		if res.IsEncrypted && a.ArchivePassword == "" {
			status = "locked"
		}
		_, err = h.Store.ApplyReindexedEntries(r.Context(), a.ID, actor.ID, storeEntryInputs(res), status)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", a.Filename, err))
			continue
		}
		h.indexArchiveCookies(r.Context(), a.ID, activePath, a.Format, a.ArchivePassword, res.Entries)
		reindexed++
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"reindexed": reindexed,
		"total":     len(archives),
		"errors":    errs,
	})
}

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
		for i, a := range archives {
			activePath := h.syncNamedLink(a.Filename, a.StoragePath)
			res, err := h.Index(ctx, activePath, a.Format, a.ArchivePassword)
			if err != nil {
				h.Log.Error("reindexAllCookies: indexing failed", "filename", a.Filename, "error", err)
				continue
			}
			h.indexArchiveCookies(ctx, a.ID, activePath, a.Format, a.ArchivePassword, res.Entries)
			h.Log.Info("reindexAllCookies: completed archive", "index", i+1, "total", len(archives), "filename", a.Filename)
		}
	}()
	WriteJSON(w, http.StatusOK, map[string]any{"status": "started", "message": "Background cookie extraction started across all archives."})
}

// reindexOne handles POST /api/archives/{id}/reindex
func (h *archiveHandlers) reindexOne(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}

	id := r.PathValue("id")
	a, err := h.Store.GetArchiveForReindex(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			WriteError(w, NotFound)
			return
		}
		h.logInternal(r.Context(), "loading archive for reindex failed", err)
		WriteError(w, InternalServerError)
		return
	}

	activePath := h.syncNamedLink(a.Filename, a.StoragePath)
	res, err := h.Index(r.Context(), activePath, a.Format, a.ArchivePassword)
	if err != nil {
		WriteError(w, &APIError{
			Status:  http.StatusUnprocessableEntity,
			Code:    "reindex_failed",
			Message: fmt.Sprintf("Failed to reindex archive: %v", err),
		})
		return
	}
	status := "indexed"
	if res.IsEncrypted && a.ArchivePassword == "" {
		status = "locked"
	}
	item, err := h.Store.ApplyReindexedEntries(r.Context(), a.ID, actor.ID, storeEntryInputs(res), status)
	if err != nil {
		h.logInternal(r.Context(), "applying reindexed entries failed", err)
		WriteError(w, InternalServerError)
		return
	}
	h.indexArchiveCookies(r.Context(), a.ID, activePath, a.Format, a.ArchivePassword, res.Entries)
	WriteJSON(w, http.StatusOK, map[string]any{"archive": item})
}

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

// CleanTempFilesNow immediately deletes all temporary upload files, download staging
// directories, orphaned storage blobs not present in the database, and broken symlinks.
// Returns the total bytes freed and number of items removed.
func (h *archiveHandlers) CleanTempFilesNow(ctx context.Context) (freedBytes int64, removedCount int, err error) {
	// 1. Clean temporary upload files in StorageDir and os.TempDir()/archive-uploads
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
			var size int64
			if ierr == nil {
				size = info.Size()
			}
			full := filepath.Join(dir, name)
			if os.Remove(full) == nil {
				freedBytes += size
				removedCount++
			}
		}
	}

	// 2. Clean staged downloads in os.TempDir()/archive-downloads
	dlRoot := filepath.Join(os.TempDir(), "archive-downloads")
	if dlEntries, rerr := os.ReadDir(dlRoot); rerr == nil {
		for _, e := range dlEntries {
			full := filepath.Join(dlRoot, e.Name())
			var dirSize int64
			_ = filepath.Walk(full, func(_ string, info os.FileInfo, err error) error {
				if err == nil && info != nil && !info.IsDir() {
					dirSize += info.Size()
				}
				return nil
			})
			if os.RemoveAll(full) == nil {
				freedBytes += dirSize
				removedCount++
			}
		}
	}

	// 3. Clean orphaned archive blobs in StorageDir that have no database record
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
				full := filepath.Clean(filepath.Join(h.StorageDir, e.Name()))
				if !validPaths[full] {
					var size int64
					if info, ierr := e.Info(); ierr == nil {
						size = info.Size()
					}
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

