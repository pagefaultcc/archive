package httpx

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"archive/backend/internal/store"
)

type validatorHandlers struct {
	Store *store.Store
	Log   *slog.Logger
}

func newValidatorHandlers(st *store.Store, log *slog.Logger) *validatorHandlers {
	return &validatorHandlers{Store: st, Log: log}
}

func (h *validatorHandlers) logInternal(ctx context.Context, msg string, err error) {
	h.Log.Error(msg, "request_id", RequestID(ctx), "error", err.Error())
}

// GET /api/validator?service=chatgpt&status=&limit=100&offset=0
func (h *validatorHandlers) list(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	service := strings.TrimSpace(r.URL.Query().Get("service"))
	if service == "" {
		service = "chatgpt"
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))

	limit := 100
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if n, err := strconv.Atoi(lStr); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	offset := 0
	if oStr := r.URL.Query().Get("offset"); oStr != "" {
		if n, err := strconv.Atoi(oStr); err == nil && n >= 0 {
			offset = n
		}
	}

	items, summary, err := h.Store.ListValidationItems(r.Context(), service, status, limit, offset)
	if err != nil {
		h.logInternal(r.Context(), "listing validation items failed", err)
		WriteError(w, InternalServerError)
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"service": service,
		"status":  status,
		"items":   items,
		"summary": summary,
		"limit":   limit,
		"offset":  offset,
	})
}

type addDomainPayload struct {
	Domain  string `json:"domain"`
	Service string `json:"service"`
}

// POST /api/validator/domain
func (h *validatorHandlers) addDomain(w http.ResponseWriter, r *http.Request) {
	if mustActor(r) == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req addDomainPayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	if req.Domain == "" {
		WriteError(w, WithFields(map[string]string{"domain": "Domain is required."}))
		return
	}

	count, err := h.Store.AddValidationDomain(r.Context(), req.Domain, req.Service)
	if err != nil {
		h.logInternal(r.Context(), "adding domain to validator failed", err)
		WriteError(w, InternalServerError)
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"status":     "ok",
		"addedCount": count,
		"message":    fmt.Sprintf("Queued %d log items for %s into validator", count, req.Domain),
	})
}

type addLogPayload struct {
	LogID   int64  `json:"logId"`
	Service string `json:"service"`
}

// POST /api/validator/log
func (h *validatorHandlers) addLog(w http.ResponseWriter, r *http.Request) {
	if mustActor(r) == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req addLogPayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	if req.LogID <= 0 {
		WriteError(w, WithFields(map[string]string{"logId": "Valid logId is required."}))
		return
	}

	id, err := h.Store.AddValidationLog(r.Context(), req.LogID, req.Service)
	if err != nil {
		h.logInternal(r.Context(), "adding log to validator failed", err)
		WriteError(w, InternalServerError)
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"id":     id,
	})
}

type addCustomPayload struct {
	Domain     string `json:"domain"`
	Service    string `json:"service"`
	CookieText string `json:"cookieText"`
}

// POST /api/validator/custom
func (h *validatorHandlers) addCustom(w http.ResponseWriter, r *http.Request) {
	if mustActor(r) == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req addCustomPayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	if strings.TrimSpace(req.CookieText) == "" {
		WriteError(w, WithFields(map[string]string{"cookieText": "Cookie text cannot be empty."}))
		return
	}

	id, err := h.Store.AddValidationCustom(r.Context(), req.Domain, req.Service, req.CookieText)
	if err != nil {
		h.logInternal(r.Context(), "adding custom cookies to validator failed", err)
		WriteError(w, InternalServerError)
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"id":     id,
	})
}

type checkPayload struct {
	Service string   `json:"service"`
	IDs     []string `json:"ids"`
}

// POST /api/validator/check
func (h *validatorHandlers) check(w http.ResponseWriter, r *http.Request) {
	if mustActor(r) == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req checkPayload
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}

	checked, err := h.Store.CheckValidationItems(r.Context(), req.Service, req.IDs)
	if err != nil {
		h.logInternal(r.Context(), "checking validation items failed", err)
		WriteError(w, InternalServerError)
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"status":       "ok",
		"checkedCount": checked,
	})
}

type clearPayload struct {
	Service string `json:"service"`
}

// DELETE /api/validator
func (h *validatorHandlers) clear(w http.ResponseWriter, r *http.Request) {
	if mustActor(r) == nil {
		WriteError(w, Unauthenticated)
		return
	}
	service := strings.TrimSpace(r.URL.Query().Get("service"))
	if service == "" {
		var req clearPayload
		_ = DecodeJSON(r, &req)
		service = req.Service
	}

	if err := h.Store.ClearValidationItems(r.Context(), service); err != nil {
		h.logInternal(r.Context(), "clearing validator items failed", err)
		WriteError(w, InternalServerError)
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"cleared": true,
	})
}

// GET /api/validator/export?service=chatgpt
func (h *validatorHandlers) export(w http.ResponseWriter, r *http.Request) {
	if _, ok := SessionFrom(r.Context()); !ok {
		WriteError(w, Unauthenticated)
		return
	}
	service := strings.TrimSpace(r.URL.Query().Get("service"))
	if service == "" {
		service = "chatgpt"
	}

	content, err := h.Store.GetValidCookiesExport(r.Context(), service)
	if err != nil {
		h.logInternal(r.Context(), "exporting valid cookies failed", err)
		WriteError(w, InternalServerError)
		return
	}

	filename := fmt.Sprintf("%s-valid-cookies-%s.txt", service, strings.ReplaceAll(time.Now().Format("2006-01-02-150405"), ":", "-"))
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(content))
}
