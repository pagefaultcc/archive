package httpx

import (
	"archive/backend/internal/archiveidx"
	"archive/backend/internal/store"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// maxArchiveBytes is the 100 GiB upload limit.
const maxArchiveBytes = 100 << 30

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
	h.indexArchiveCredentials(r.Context(), id, storagePath, format, req.Password, res.Entries)
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
	if err := h.Store.MarkArchiveDeleting(r.Context(), id); err != nil {
		h.writeArchiveStoreError(w, r, err)
		return
	}
	h.Store.InvalidateCookieCache()

	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		storagePath, err := h.Store.DeleteArchive(bgCtx, id, actor.ID)
		if err != nil {
			h.Log.Error("background archive delete failed", "archive_id", id, "error", err.Error())
			return
		}
		h.Store.InvalidateCookieCache()
		if storagePath != "" {
			if stillUsed, cerr := h.Store.HasArchiveWithStoragePath(bgCtx, storagePath); cerr == nil && !stillUsed {
				_ = os.Remove(storagePath)
			}
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
	h.indexArchiveCredentials(r.Context(), item.ID, activePath, format, savedPassword, res.Entries)
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

	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	archives, err := h.Store.GetAllArchivesForReindex(r.Context())
	if err != nil {
		h.logInternal(r.Context(), "getting archives for reindex failed", err)
		WriteError(w, InternalServerError)
		return
	}

	// Sync all by-name symlinks upfront so multipart volumes can resolve sibling parts.
	for _, a := range archives {
		_ = h.syncNamedLink(a.Filename, a.StoragePath)
	}

	type bgJob struct {
		id          string
		activePath  string
		format      string
		effectivePw string
		entries     []archiveidx.Entry
	}
	var bgJobs []bgJob

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
		if res.PasswordRequired {
			status = "password_required"
		}
		effectivePw := a.ArchivePassword
		if effectivePw == "" && res.MatchedPassword != "" {
			effectivePw = res.MatchedPassword
			_ = h.Store.SetArchivePassword(r.Context(), a.ID, effectivePw)
		}
		_, err = h.Store.ApplyReindexedEntries(r.Context(), a.ID, actor.ID, storeEntryInputs(res), status)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", a.Filename, err))
			continue
		}
		if status == "indexed" {
			if len(archives) <= 3 {
				h.indexArchiveCookies(r.Context(), a.ID, activePath, a.Format, effectivePw, res.Entries)
				h.indexArchiveCredentials(r.Context(), a.ID, activePath, a.Format, effectivePw, res.Entries)
			} else {
				bgJobs = append(bgJobs, bgJob{
					id:          a.ID,
					activePath:  activePath,
					format:      a.Format,
					effectivePw: effectivePw,
					entries:     res.Entries,
				})
			}
		}
		reindexed++
	}

	if len(bgJobs) > 0 {
		go func(jobs []bgJob) {
			bgCtx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
			defer cancel()
			for _, j := range jobs {
				h.indexArchiveCookies(bgCtx, j.id, j.activePath, j.format, j.effectivePw, j.entries)
				h.indexArchiveCredentials(bgCtx, j.id, j.activePath, j.format, j.effectivePw, j.entries)
			}
		}(bgJobs)
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"reindexed": reindexed,
		"total":     len(archives),
		"errors":    errs,
	})
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
	if res.PasswordRequired {
		status = "password_required"
	}
	effectivePw := a.ArchivePassword
	if effectivePw == "" && res.MatchedPassword != "" {
		effectivePw = res.MatchedPassword
		_ = h.Store.SetArchivePassword(r.Context(), a.ID, effectivePw)
	}
	item, err := h.Store.ApplyReindexedEntries(r.Context(), a.ID, actor.ID, storeEntryInputs(res), status)
	if err != nil {
		h.logInternal(r.Context(), "applying reindexed entries failed", err)
		WriteError(w, InternalServerError)
		return
	}
	if status == "indexed" {
		h.indexArchiveCookies(r.Context(), a.ID, activePath, a.Format, effectivePw, res.Entries)
		h.indexArchiveCredentials(r.Context(), a.ID, activePath, a.Format, effectivePw, res.Entries)
	}
	WriteJSON(w, http.StatusOK, map[string]any{"archive": item})
}
