package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"
)

const maxBodyBytes = 16 * 1024 * 1024

type ctxKey string

const requestIDKey ctxKey = "request_id"

// RequestID returns the generated request ID from the context.
func RequestID(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// RequestLogger assigns a request ID and logs method/path/status/duration
// with sanitized internal errors only — never bodies, cookies, or tokens.
func RequestLogger(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := newRequestID()
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		r = r.WithContext(ctx)
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		start := timeNow()
		next.ServeHTTP(rec, r)
		log.Info("request",
			"request_id", id,
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration", timeNow().Sub(start).String(),
		)
	})
}

// DecodeJSON strictly decodes an 8 KiB application/json body, rejecting
// unknown fields, trailing JSON, and non-UTF-8 input.
func DecodeJSON(r *http.Request, v any) *APIError {
	ct := r.Header.Get("Content-Type")
	mediaType := strings.TrimSpace(strings.ToLower(strings.Split(ct, ";")[0]))
	if mediaType != "application/json" {
		return UnsupportedMediaType
	}
	charset := ""
	if i := strings.Index(strings.ToLower(ct), "charset="); i >= 0 {
		charset = strings.TrimSpace(ct[i+len("charset="):])
	}
	if charset != "" && charset != "utf-8" {
		return UnsupportedMediaType
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return InternalServerError
	}
	if len(body) > maxBodyBytes {
		return BodyTooLarge
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return WithFields(map[string]string{"body": "Request body is required."})
	}
	if !utf8.Valid(body) {
		return InvalidRequest
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return InvalidRequest
	}
	// A second decode must reach EOF; any trailing value or token is invalid.
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return InvalidRequest
	}
	return nil
}

func newRequestID() string {
	var b [16]byte
	// crypto/rand-backed random hex identifier.
	_, _ = randRead(b[:])
	return fmt.Sprintf("%x", b[:])
}
