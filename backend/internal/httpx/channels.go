package httpx

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"archive/backend/internal/archiveidx"
	"archive/backend/internal/store"
)

type telegramQueueItem struct {
	ID          string    `json:"id"`
	ChannelID   string    `json:"channelId"`
	MessageID   int       `json:"messageId"`
	Filename    string    `json:"filename"`
	Password    string    `json:"-"`
	Stage       string    `json:"stage"` // "queued", "downloading", "indexing", "done", "skipped", "error"
	StatusText  string    `json:"statusText"`
	LoadedBytes int64     `json:"loadedBytes"`
	TotalBytes  int64     `json:"totalBytes"`
	Percent     float64   `json:"percent"`
	SpeedMbps   float64   `json:"speedMbps"`
	ETASeconds  int       `json:"etaSeconds"`
	ArchiveID   string    `json:"archiveId,omitempty"`
	Error       string    `json:"error,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	ActorID     string    `json:"-"`
}

type channelHandlers struct {
	Store         *store.Store
	Log           *slog.Logger
	StorageDir    string
	queueMu       sync.RWMutex
	activeItems   map[string]*telegramQueueItem
	pendingQueue  []*telegramQueueItem
	completedList []*telegramQueueItem
	wakeWorker    chan struct{}
}

func newChannelHandlers(st *store.Store, log *slog.Logger) *channelHandlers {
	dir := os.Getenv("ARCHIVE_STORAGE_DIR")
	if dir == "" {
		dir = filepath.Join(os.TempDir(), "archive-uploads")
	}
	h := &channelHandlers{
		Store:         st,
		Log:           log,
		StorageDir:    dir,
		activeItems:   make(map[string]*telegramQueueItem),
		wakeWorker:    make(chan struct{}, 1),
		completedList: make([]*telegramQueueItem, 0, 50),
		pendingQueue:  make([]*telegramQueueItem, 0, 100),
	}
	go h.serverQueueWorker()
	return h
}

func (h *channelHandlers) logInternal(ctx context.Context, msg string, err error) {
	h.Log.Error(msg, "request_id", RequestID(ctx), "error", err.Error())
}

func findScriptEnginePath() string {
	candidates := []string{
		"/app/scraper/tg_engine.py",
		"backend/scraper/tg_engine.py",
		"scraper/tg_engine.py",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return "backend/scraper/tg_engine.py"
}

// GET /api/channels/settings
func (h *channelHandlers) getSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	set, err := h.Store.GetTelegramSettings(r.Context())
	if err != nil {
		h.logInternal(r.Context(), "loading telegram settings failed", err)
		WriteError(w, InternalServerError)
		return
	}
	masked := set
	if len(masked.SessionString) > 12 {
		masked.SessionString = masked.SessionString[:6] + "..." + masked.SessionString[len(masked.SessionString)-4:]
	}
	WriteJSON(w, http.StatusOK, map[string]any{"settings": masked})
}

type updateTelegramSettingsRequest struct {
	APIID         int    `json:"apiId"`
	APIHash       string `json:"apiHash"`
	SessionString string `json:"sessionString"`
}

// PUT /api/channels/settings
func (h *channelHandlers) updateSettings(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req updateTelegramSettingsRequest
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	set := store.UserBotSettings{
		APIID:         req.APIID,
		APIHash:       strings.TrimSpace(req.APIHash),
		SessionString: strings.TrimSpace(req.SessionString),
	}
	if err := h.Store.SetTelegramSettings(r.Context(), set, actor.ID); err != nil {
		h.logInternal(r.Context(), "saving telegram settings failed", err)
		WriteError(w, InternalServerError)
		return
	}
	set.IsConfigured = set.APIID > 0 && set.APIHash != "" && set.SessionString != ""
	WriteJSON(w, http.StatusOK, map[string]any{"settings": set})
}

// POST /api/channels/test-connection
func (h *channelHandlers) testConnection(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	set, err := h.Store.GetTelegramSettings(r.Context())
	if err != nil || !set.IsConfigured {
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "not_configured",
			Message: "Telegram UserBot credentials are not configured.",
		})
		return
	}

	enginePath := findScriptEnginePath()
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "python3", enginePath, "check_connection",
		strconv.Itoa(set.APIID), set.APIHash, set.SessionString,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		h.logInternal(r.Context(), "check_connection execution failed", fmt.Errorf("%v: %s", err, string(out)))
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "connection_failed",
			Message: fmt.Sprintf("Telethon connection failed: %s", strings.TrimSpace(string(out))),
		})
		return
	}

	var res map[string]any
	if jerr := json.Unmarshal(out, &res); jerr != nil {
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "invalid_response",
			Message: strings.TrimSpace(string(out)),
		})
		return
	}

	WriteJSON(w, http.StatusOK, res)
}

// GET /api/channels
func (h *channelHandlers) list(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	channels, err := h.Store.ListTelegramChannels(r.Context())
	if err != nil {
		h.logInternal(r.Context(), "listing channels failed", err)
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"channels": channels})
}

type channelPayload struct {
	Name           string `json:"name"`
	ChannelID      string `json:"channelId"`
	PasswordScript string `json:"passwordScript"`
}

// POST /api/channels
func (h *channelHandlers) create(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req channelPayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.ChannelID) == "" {
		WriteError(w, WithFields(map[string]string{
			"name":      "Name is required",
			"channelId": "Channel ID is required",
		}))
		return
	}
	c, err := h.Store.CreateTelegramChannel(r.Context(), req.Name, req.ChannelID, req.PasswordScript, actor.ID)
	if err != nil {
		h.logInternal(r.Context(), "creating channel failed", err)
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusCreated, map[string]any{"channel": c})
}

// PUT /api/channels/{id}
func (h *channelHandlers) update(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	id := r.PathValue("id")
	var req channelPayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	c, err := h.Store.UpdateTelegramChannel(r.Context(), id, req.Name, req.ChannelID, req.PasswordScript, actor.ID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			WriteError(w, NotFound)
			return
		}
		h.logInternal(r.Context(), "updating channel failed", err)
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"channel": c})
}

// DELETE /api/channels/{id}
func (h *channelHandlers) delete(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	id := r.PathValue("id")
	if err := h.Store.DeleteTelegramChannel(r.Context(), id, actor.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			WriteError(w, NotFound)
			return
		}
		h.logInternal(r.Context(), "deleting channel failed", err)
		WriteError(w, InternalServerError)
		return
	}
	WriteNoContent(w)
}

type testScriptPayload struct {
	Script         string `json:"script"`
	MessageContent string `json:"messageContent"`
}

// POST /api/channels/test-script
func (h *channelHandlers) testScript(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	var req testScriptPayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}

	enginePath := findScriptEnginePath()
	tmpScript, err := os.CreateTemp("", "script-*.py")
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	defer os.Remove(tmpScript.Name())
	_, _ = tmpScript.WriteString(req.Script)
	_ = tmpScript.Close()

	tmpMsg, err := os.CreateTemp("", "msg-*.txt")
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	defer os.Remove(tmpMsg.Name())
	_, _ = tmpMsg.WriteString(req.MessageContent)
	_ = tmpMsg.Close()

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "python3", enginePath, "test_password_script",
		"--script", tmpScript.Name(), "--message", tmpMsg.Name(),
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "script_error",
			Message: fmt.Sprintf("Script test failed: %s", string(out)),
		})
		return
	}

	var res map[string]any
	if jerr := json.Unmarshal(out, &res); jerr != nil {
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "invalid_response",
			Message: string(out),
		})
		return
	}
	WriteJSON(w, http.StatusOK, res)
}

type scrapePayload struct {
	ChannelID string `json:"channelId"`
	Limit     int    `json:"limit"`
}

// POST /api/channels/scrape
func (h *channelHandlers) scrape(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	var req scrapePayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	if req.Limit <= 0 || req.Limit > 500 {
		req.Limit = 100
	}

	set, err := h.Store.GetTelegramSettings(r.Context())
	if err != nil || !set.IsConfigured {
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "not_configured",
			Message: "Telegram UserBot credentials are not configured in Channels settings.",
		})
		return
	}

	// Resolve channel config to get custom password script if channel exists by ID
	scriptCode := ""
	channelTarget := req.ChannelID
	if c, err := h.Store.GetTelegramChannel(r.Context(), req.ChannelID); err == nil {
		channelTarget = c.ChannelID
		scriptCode = c.PasswordScript
	}

	enginePath := findScriptEnginePath()
	var scriptArg string
	var tmpScript *os.File
	if scriptCode != "" {
		tmpScript, err = os.CreateTemp("", "script-*.py")
		if err == nil {
			defer os.Remove(tmpScript.Name())
			_, _ = tmpScript.WriteString(scriptCode)
			_ = tmpScript.Close()
			scriptArg = tmpScript.Name()
		}
	}

	args := []string{
		enginePath, "scrape_messages",
		strconv.Itoa(set.APIID), set.APIHash, set.SessionString,
		channelTarget, strconv.Itoa(req.Limit),
	}
	if scriptArg != "" {
		args = append(args, "--script", scriptArg)
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "python3", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		h.logInternal(r.Context(), "scrape_messages failed", fmt.Errorf("%v: %s", err, string(out)))
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "scrape_failed",
			Message: fmt.Sprintf("Channel scrape failed: %s", strings.TrimSpace(string(out))),
		})
		return
	}

	var res map[string]any
	if jerr := json.Unmarshal(out, &res); jerr != nil {
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "invalid_response",
			Message: string(out),
		})
		return
	}

	// Annotate candidates with alreadyArchived (matching both filename and size) and blacklisted flags
	existingMap, _ := h.Store.GetExistingArchivesMap(r.Context())
	blacklistMap, _ := h.Store.GetTelegramBlacklistMessageIDs(r.Context(), channelTarget)

	if rawItems, ok := res["items"].([]any); ok {
		for _, raw := range rawItems {
			if itMap, ok := raw.(map[string]any); ok {
				fn, _ := itMap["filename"].(string)
				sizeFloat, _ := itMap["sizeBytes"].(float64)
				sizeBytes := int64(sizeFloat)

				if store.IsArchived(existingMap, fn, sizeBytes) {
					itMap["alreadyArchived"] = true
				} else {
					itMap["alreadyArchived"] = false
				}

				midFloat, _ := itMap["messageId"].(float64)
				mid := int64(midFloat)
				if reason, isBl := blacklistMap[mid]; isBl {
					itMap["blacklisted"] = true
					itMap["blacklistReason"] = reason
				} else {
					itMap["blacklisted"] = false
				}
			}
		}
	}
	WriteJSON(w, http.StatusOK, res)
}

type importItemPayload struct {
	MessageID int    `json:"messageId"`
	Filename  string `json:"filename"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
	Password  string `json:"password"`
}

type importRequestPayload struct {
	ChannelID string              `json:"channelId"`
	Items     []importItemPayload `json:"items"`
}

// POST /api/channels/import
func (h *channelHandlers) importFiles(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req importRequestPayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	if len(req.Items) == 0 {
		WriteError(w, WithFields(map[string]string{"items": "At least one item must be selected for import"}))
		return
	}

	set, err := h.Store.GetTelegramSettings(r.Context())
	if err != nil || !set.IsConfigured {
		WriteError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "not_configured",
			Message: "Telegram UserBot credentials are not configured.",
		})
		return
	}

	channelTarget := req.ChannelID
	if c, err := h.Store.GetTelegramChannel(r.Context(), req.ChannelID); err == nil {
		channelTarget = c.ChannelID
	}

	enginePath := findScriptEnginePath()
	importedCount := 0
	failedCount := 0
	var results []map[string]any

	for _, item := range req.Items {
		// Pre-download blacklist check: skip if previously flagged as bad password
		if isBl, _ := h.Store.IsTelegramBlacklisted(r.Context(), channelTarget, int64(item.MessageID), ""); isBl {
			results = append(results, map[string]any{
				"filename": item.Filename,
				"status":   "blacklisted",
				"error":    "Skipped download: blacklisted due to previous bad password",
			})
			continue
		}

		tmpDownload, err := os.CreateTemp(h.StorageDir, "tg-download-*")
		if err != nil {
			failedCount++
			results = append(results, map[string]any{
				"filename": item.Filename,
				"status":   "failed",
				"error":    err.Error(),
			})
			continue
		}
		tmpPath := tmpDownload.Name()
		_ = tmpDownload.Close()

		ctx, cancel := context.WithTimeout(r.Context(), 1800*time.Second)
		cmd := exec.CommandContext(ctx, "python3", enginePath, "download_document",
			strconv.Itoa(set.APIID), set.APIHash, set.SessionString,
			channelTarget, strconv.Itoa(item.MessageID), tmpPath,
		)
		out, err := cmd.CombinedOutput()
		cancel()

		if err != nil {
			_ = os.Remove(tmpPath)
			failedCount++
			errMsg := extractJSONErrorMessage(out)
			if errMsg == "" {
				errMsg = strings.TrimSpace(string(out))
			}
			if errMsg == "" {
				errMsg = err.Error()
			}
			results = append(results, map[string]any{
				"filename": item.Filename,
				"status":   "failed",
				"error":    fmt.Sprintf("Download failed: %s", errMsg),
			})
			continue
		}

		info, serr := os.Stat(tmpPath)
		if serr != nil || info.Size() == 0 {
			_ = os.Remove(tmpPath)
			failedCount++
			errMsg := extractJSONErrorMessage(out)
			if errMsg == "" {
				errMsg = "Downloaded file is empty or missing"
			}
			results = append(results, map[string]any{
				"filename": item.Filename,
				"status":   "failed",
				"error":    errMsg,
			})
			continue
		}

		// Compute sha256 and read header
		f, oerr := os.Open(tmpPath)
		if oerr != nil {
			_ = os.Remove(tmpPath)
			failedCount++
			continue
		}
		hasher := sha256.New()
		head := make([]byte, 8)
		headN, _ := io.ReadFull(f, head)
		head = head[:headN]
		_, _ = f.Seek(0, 0)
		_, _ = io.Copy(hasher, f)
		_ = f.Close()

		sha := hex.EncodeToString(hasher.Sum(nil))

		// Post-download duplicate & blacklist check by SHA-256
		if isBl, _ := h.Store.IsTelegramBlacklisted(r.Context(), channelTarget, int64(item.MessageID), sha); isBl {
			_ = os.Remove(tmpPath)
			results = append(results, map[string]any{
				"filename": item.Filename,
				"status":   "blacklisted",
				"error":    "Skipped: blacklisted due to previous bad password (SHA-256 matched)",
			})
			continue
		}

		// Deduplication check: verify if an archive with this exact SHA-256 is already stored
		if existing, found, err := h.Store.GetArchiveBySHA256(r.Context(), sha); err == nil && found {
			_ = os.Remove(tmpPath)
			results = append(results, map[string]any{
				"filename": item.Filename,
				"status":   "already_exists",
				"message":  fmt.Sprintf("Already archived as %q (SHA-256 matched)", existing.Filename),
			})
			continue
		}

		format, derr := archiveidx.DetectFormat(item.Filename, head)
		if derr != nil {
			_ = os.Remove(tmpPath)
			failedCount++
			results = append(results, map[string]any{
				"filename": item.Filename,
				"status":   "failed",
				"error":    fmt.Sprintf("Unsupported format: %v", derr),
			})
			continue
		}
		ext := strings.ToLower(filepath.Ext(item.Filename))
		storagePath := filepath.Join(h.StorageDir, sha+ext)
		_ = os.Remove(storagePath)
		if rerr := os.Rename(tmpPath, storagePath); rerr != nil {
			_ = os.Remove(tmpPath)
			failedCount++
			continue
		}

		// Try indexing with the resolved password
		activePath := storagePath
		res, ierr := archiveidx.IndexFile(r.Context(), activePath, format, item.Password)
		if ierr != nil {
			// Password failure fallback: "Some file passwords can be wrong, if its failed because of password just drop it and go on next one"
			h.logInternal(r.Context(), fmt.Sprintf("password/indexing failed for %s", item.Filename), ierr)
			_ = os.Remove(storagePath)
			failedCount++

			// Record in blacklist so it never downloads again
			_ = h.Store.AddTelegramBlacklist(r.Context(), channelTarget, int64(item.MessageID), item.Filename, sha, "bad_password")

			results = append(results, map[string]any{
				"filename": item.Filename,
				"status":   "password_failed",
				"error":    "Bad password, skipped and blacklisted from future downloads.",
			})
			continue
		}

		savedPassword := item.Password
		if savedPassword == "" && res.MatchedPassword != "" {
			savedPassword = res.MatchedPassword
		}

		archItem, aerr := h.Store.CreateArchive(r.Context(), store.CreateArchiveInput{
			OwnerID: actor.ID, Filename: item.Filename, Format: format,
			SizeBytes: info.Size(), SHA256: sha, IsEncrypted: res.IsEncrypted,
			ArchivePassword: savedPassword, Status: "indexed", StoragePath: storagePath,
			Entries: storeEntryInputs(res),
		})
		if aerr != nil {
			_ = os.Remove(storagePath)
			failedCount++
			continue
		}
		h.indexDownloadedCookies(archItem.ID, activePath, format, savedPassword, res.Entries)

		importedCount++
		results = append(results, map[string]any{
			"filename": item.Filename,
			"status":   "imported",
			"id":       archItem.ID,
		})
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"imported": importedCount,
		"failed":   failedCount,
		"results":  results,
	})
}

// DELETE /api/channels/blacklist?channelId=...
func (h *channelHandlers) clearBlacklist(w http.ResponseWriter, r *http.Request) {
	if mustActor(r) == nil {
		WriteError(w, Unauthenticated)
		return
	}
	channelID := strings.TrimSpace(r.URL.Query().Get("channelId"))
	if c, err := h.Store.GetTelegramChannel(r.Context(), channelID); err == nil {
		channelID = c.ChannelID
	}
	if err := h.Store.ClearTelegramBlacklist(r.Context(), channelID); err != nil {
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"status": "ok", "cleared": true})
}

type enqueueBatchPayload struct {
	ChannelID string `json:"channelId"`
	Items     []struct {
		MessageID int    `json:"messageId"`
		Filename  string `json:"filename"`
		SizeBytes int64  `json:"sizeBytes,omitempty"`
		Password  string `json:"password"`
	} `json:"items"`
}

// POST /api/channels/queue
func (h *channelHandlers) enqueueBatch(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req enqueueBatchPayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	if len(req.Items) == 0 {
		WriteError(w, WithFields(map[string]string{"items": "No archives selected"}))
		return
	}

	channelTarget := req.ChannelID
	if c, err := h.Store.GetTelegramChannel(r.Context(), req.ChannelID); err == nil {
		channelTarget = c.ChannelID
	}

	existingMap, _ := h.Store.GetExistingArchivesMap(r.Context())
	blacklistMap, _ := h.Store.GetTelegramBlacklistMessageIDs(r.Context(), channelTarget)

	var toQueue []*telegramQueueItem
	var skippedCount int

	for _, it := range req.Items {
		if _, isBl := blacklistMap[int64(it.MessageID)]; isBl {
			skippedCount++
			continue
		}
		if store.IsArchived(existingMap, it.Filename, it.SizeBytes) {
			skippedCount++
			continue
		}

		item := &telegramQueueItem{
			ID:         fmt.Sprintf("q-%d-%d", it.MessageID, time.Now().UnixNano()),
			ChannelID:  channelTarget,
			MessageID:  it.MessageID,
			Filename:   it.Filename,
			Password:   it.Password,
			Stage:      "queued",
			StatusText: "Waiting in queue…",
			CreatedAt:  time.Now(),
			ActorID:    actor.ID,
		}
		toQueue = append(toQueue, item)
	}

	h.queueMu.Lock()
	h.pendingQueue = append(h.pendingQueue, toQueue...)
	h.queueMu.Unlock()

	select {
	case h.wakeWorker <- struct{}{}:
	default:
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"status":       "ok",
		"queuedCount":  len(toQueue),
		"skippedCount": skippedCount,
	})
}

// GET /api/channels/queue
func (h *channelHandlers) getQueueStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	h.queueMu.RLock()
	defer h.queueMu.RUnlock()

	activeList := make([]*telegramQueueItem, 0, len(h.activeItems))
	var totalSpeed float64
	for _, it := range h.activeItems {
		activeList = append(activeList, it)
		totalSpeed += it.SpeedMbps
	}

	var primaryActive *telegramQueueItem
	if len(activeList) > 0 {
		primaryActive = activeList[0]
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"active":         primaryActive,
		"activeList":     activeList,
		"totalSpeedMbps": totalSpeed,
		"pendingCount":   len(h.pendingQueue),
		"pending":        h.pendingQueue,
		"completed":      h.completedList,
	})
}

// DELETE /api/channels/queue
func (h *channelHandlers) clearQueue(w http.ResponseWriter, r *http.Request) {
	if mustActor(r) == nil {
		WriteError(w, Unauthenticated)
		return
	}
	h.queueMu.Lock()
	h.pendingQueue = nil
	h.completedList = nil
	h.queueMu.Unlock()

	WriteJSON(w, http.StatusOK, map[string]any{"status": "ok", "cleared": true})
}

func (h *channelHandlers) serverQueueWorker() {
	const maxConcurrent = 3
	for {
		h.queueMu.Lock()
		for len(h.pendingQueue) > 0 && len(h.activeItems) < maxConcurrent {
			item := h.pendingQueue[0]
			h.pendingQueue = h.pendingQueue[1:]
			h.activeItems[item.ID] = item

			go func(it *telegramQueueItem) {
				h.processQueueItem(it)

				h.queueMu.Lock()
				delete(h.activeItems, it.ID)
				h.completedList = append(h.completedList, it)
				if len(h.completedList) > 50 {
					h.completedList = h.completedList[len(h.completedList)-50:]
				}
				h.queueMu.Unlock()

				select {
				case h.wakeWorker <- struct{}{}:
				default:
				}
			}(item)
		}
		h.queueMu.Unlock()

		<-h.wakeWorker
	}
}

func (h *channelHandlers) processQueueItem(item *telegramQueueItem) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	set, err := h.Store.GetTelegramSettings(ctx)
	if err != nil || !set.IsConfigured {
		h.queueMu.Lock()
		item.Stage = "error"
		item.Error = "Telegram UserBot credentials not configured"
		h.queueMu.Unlock()
		return
	}

	if isBl, _ := h.Store.IsTelegramBlacklisted(ctx, item.ChannelID, int64(item.MessageID), ""); isBl {
		h.queueMu.Lock()
		item.Stage = "skipped"
		item.StatusText = "Blacklisted (bad password)"
		h.queueMu.Unlock()
		return
	}

	tmpDownload, err := os.CreateTemp(h.StorageDir, "tg-download-*")
	if err != nil {
		h.queueMu.Lock()
		item.Stage = "error"
		item.Error = err.Error()
		h.queueMu.Unlock()
		return
	}
	tmpPath := tmpDownload.Name()
	_ = tmpDownload.Close()

	h.queueMu.Lock()
	item.Stage = "downloading"
	item.StatusText = "Connecting to Telegram…"
	h.queueMu.Unlock()

	enginePath := findScriptEnginePath()
	cmd := exec.CommandContext(ctx, "python3", "-u", enginePath, "download_document",
		strconv.Itoa(set.APIID), set.APIHash, set.SessionString,
		item.ChannelID, strconv.Itoa(item.MessageID), tmpPath,
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = os.Remove(tmpPath)
		h.queueMu.Lock()
		item.Stage = "error"
		item.Error = "Failed to capture download pipe: " + err.Error()
		h.queueMu.Unlock()
		return
	}

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		_ = os.Remove(tmpPath)
		h.queueMu.Lock()
		item.Stage = "error"
		item.Error = "Failed to start downloader: " + err.Error()
		h.queueMu.Unlock()
		return
	}

	var lastErrMsg string
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "PROGRESS:") {
			var p struct {
				Loaded    int64   `json:"loaded"`
				Total     int64   `json:"total"`
				Percent   float64 `json:"percent"`
				SpeedMbps float64 `json:"speedMbps"`
			}
			if jerr := json.Unmarshal([]byte(strings.TrimPrefix(line, "PROGRESS:")), &p); jerr == nil {
				eta := 0
				if p.SpeedMbps > 0 && p.Total > p.Loaded {
					bytesPerSec := (p.SpeedMbps * 1_000_000.0) / 8.0
					remBytes := float64(p.Total - p.Loaded)
					eta = int(remBytes / bytesPerSec)
				}
				h.queueMu.Lock()
				item.LoadedBytes = p.Loaded
				item.TotalBytes = p.Total
				item.Percent = p.Percent
				item.SpeedMbps = p.SpeedMbps
				item.ETASeconds = eta
				item.StatusText = fmt.Sprintf("Downloading (%.1f%%)", p.Percent)
				h.queueMu.Unlock()
			}
		} else if strings.HasPrefix(line, "{") {
			var resp struct {
				Status  string `json:"status"`
				Message string `json:"message"`
			}
			if jerr := json.Unmarshal([]byte(line), &resp); jerr == nil && (resp.Status == "error" || resp.Status == "unauthorized") {
				if resp.Message != "" {
					lastErrMsg = resp.Message
				}
			}
		}
	}

	werr := cmd.Wait()
	if werr != nil {
		_ = os.Remove(tmpPath)
		h.queueMu.Lock()
		item.Stage = "error"
		errMsg := lastErrMsg
		if errMsg == "" {
			errMsg = strings.TrimSpace(stderr.String())
		}
		if errMsg == "" {
			errMsg = werr.Error()
		}
		item.Error = fmt.Sprintf("Download failed: %s", errMsg)
		h.queueMu.Unlock()
		return
	}

	info, serr := os.Stat(tmpPath)
	if serr != nil || info.Size() == 0 {
		_ = os.Remove(tmpPath)
		h.queueMu.Lock()
		item.Stage = "error"
		errMsg := lastErrMsg
		if errMsg == "" {
			errMsg = strings.TrimSpace(stderr.String())
		}
		if errMsg == "" {
			errMsg = "Downloaded file is empty or missing"
		}
		item.Error = errMsg
		h.queueMu.Unlock()
		return
	}

	// Indexing phase
	h.queueMu.Lock()
	item.Stage = "indexing"
	item.Percent = 100
	item.StatusText = "Hashing & indexing archive…"
	h.queueMu.Unlock()

	f, oerr := os.Open(tmpPath)
	if oerr != nil {
		_ = os.Remove(tmpPath)
		h.queueMu.Lock()
		item.Stage = "error"
		item.Error = oerr.Error()
		h.queueMu.Unlock()
		return
	}
	hasher := sha256.New()
	head := make([]byte, 8)
	headN, _ := io.ReadFull(f, head)
	head = head[:headN]
	_, _ = f.Seek(0, 0)
	_, _ = io.Copy(hasher, f)
	_ = f.Close()

	sha := hex.EncodeToString(hasher.Sum(nil))

	if isBl, _ := h.Store.IsTelegramBlacklisted(ctx, item.ChannelID, int64(item.MessageID), sha); isBl {
		_ = os.Remove(tmpPath)
		h.queueMu.Lock()
		item.Stage = "skipped"
		item.StatusText = "Blacklisted (bad password)"
		h.queueMu.Unlock()
		return
	}

	if existing, found, err := h.Store.GetArchiveBySHA256(ctx, sha); err == nil && found {
		_ = os.Remove(tmpPath)
		h.queueMu.Lock()
		item.Stage = "skipped"
		item.StatusText = fmt.Sprintf("Already in vault as %q", existing.Filename)
		h.queueMu.Unlock()
		return
	}

	format, derr := archiveidx.DetectFormat(item.Filename, head)
	if derr != nil {
		_ = os.Remove(tmpPath)
		h.queueMu.Lock()
		item.Stage = "error"
		item.Error = fmt.Sprintf("Unsupported format: %v", derr)
		h.queueMu.Unlock()
		return
	}

	ext := strings.ToLower(filepath.Ext(item.Filename))
	storagePath := filepath.Join(h.StorageDir, sha+ext)
	_ = os.Remove(storagePath)
	if rerr := os.Rename(tmpPath, storagePath); rerr != nil {
		_ = os.Remove(tmpPath)
		h.queueMu.Lock()
		item.Stage = "error"
		item.Error = rerr.Error()
		h.queueMu.Unlock()
		return
	}

	activePath := storagePath
	res, ierr := archiveidx.IndexFile(ctx, activePath, format, item.Password)
	if ierr != nil {
		h.logInternal(ctx, fmt.Sprintf("password/indexing failed for %s", item.Filename), ierr)
		_ = os.Remove(storagePath)
		_ = h.Store.AddTelegramBlacklist(ctx, item.ChannelID, int64(item.MessageID), item.Filename, sha, "bad_password")
		h.queueMu.Lock()
		item.Stage = "error"
		item.Error = "Bad password (blacklisted from future downloads)"
		h.queueMu.Unlock()
		return
	}

	savedPassword := item.Password
	if savedPassword == "" && res.MatchedPassword != "" {
		savedPassword = res.MatchedPassword
	}

	archItem, aerr := h.Store.CreateArchive(ctx, store.CreateArchiveInput{
		OwnerID:         item.ActorID,
		Filename:        item.Filename,
		Format:          format,
		SizeBytes:       info.Size(),
		SHA256:          sha,
		IsEncrypted:     res.IsEncrypted,
		ArchivePassword: savedPassword,
		Status:          "indexed",
		StoragePath:     storagePath,
		Entries:         storeEntryInputs(res),
	})
	if aerr != nil {
		_ = os.Remove(storagePath)
		h.queueMu.Lock()
		item.Stage = "error"
		item.Error = aerr.Error()
		h.queueMu.Unlock()
		return
	}

	h.indexDownloadedCookies(archItem.ID, activePath, format, savedPassword, res.Entries)
	h.queueMu.Lock()
	item.Stage = "done"
	item.StatusText = "Indexed into vault"
	item.ArchiveID = archItem.ID
	h.queueMu.Unlock()
}

func extractJSONErrorMessage(out []byte) string {
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "{") {
			var resp struct {
				Status  string `json:"status"`
				Message string `json:"message"`
			}
			if err := json.Unmarshal([]byte(line), &resp); err == nil && (resp.Status == "error" || resp.Status == "unauthorized") {
				if resp.Message != "" {
					return resp.Message
				}
			}
		}
	}
	return ""
}

func (h *channelHandlers) indexDownloadedCookies(archiveID, activePath, format, password string, entries []archiveidx.Entry) {
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer cancel()
		chunks := archiveidx.ExtractCookieDomains(bgCtx, activePath, format, password, entries)
		if len(chunks) == 0 {
			return
		}
		inputs := make([]store.CookieDomainInput, 0, len(chunks))
		for _, ch := range chunks {
			inputs = append(inputs, store.CookieDomainInput{
				EntryPath:    ch.EntryPath,
				EntryName:    ch.EntryName,
				Domain:       ch.Domain,
				CookieCount:  ch.CookieCount,
				NetscapeText: ch.NetscapeText,
				JSONText:     ch.JSONText,
			})
		}
		if err := h.Store.SaveArchiveCookieDomains(bgCtx, archiveID, inputs); err != nil {
			h.logInternal(bgCtx, "saving telegram archive cookie domains failed", err)
		}
	}()
}
