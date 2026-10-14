package httpx

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"archive/backend/internal/config"
)

func TestRequireOrigin(t *testing.T) {
	origin := config.MustParseOriginURL("http://localhost:3000")
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	h := RequireOrigin(origin, next).ServeHTTP

	ok := func(r *http.Request) int {
		w := httptest.NewRecorder()
		h(w, r)
		return w.Code
	}

	// Safe methods bypass.
	req := httptest.NewRequest("GET", "/x", nil)
	if c := ok(req); c != 200 {
		t.Errorf("GET: %d", c)
	}

	// POST missing Origin -> 403.
	req = httptest.NewRequest("POST", "/x", nil)
	if c := ok(req); c != 403 {
		t.Errorf("POST no origin: %d", c)
	}

	// Matching origin -> 200.
	req = httptest.NewRequest("POST", "/x", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	if c := ok(req); c != 200 {
		t.Errorf("POST matching: %d", c)
	}

	// Wrong origin -> 403.
	req = httptest.NewRequest("POST", "/x", nil)
	req.Header.Set("Origin", "http://evil.example")
	if c := ok(req); c != 403 {
		t.Errorf("POST wrong origin: %d", c)
	}

	// Malformed origin -> 403.
	req = httptest.NewRequest("POST", "/x", nil)
	req.Header.Set("Origin", "::bad::")
	if c := ok(req); c != 403 {
		t.Errorf("POST malformed origin: %d", c)
	}
}

func TestDecodeJSONStrict(t *testing.T) {
	var target struct {
		A string `json:"a"`
	}
	mk := func(body, ct string) *APIError {
		r := httptest.NewRequest("POST", "/x", strings.NewReader(body))
		if ct != "" {
			r.Header.Set("Content-Type", ct)
		}
		return DecodeJSON(r, &target)
	}
	if e := mk(`{"a":"b"}`, "application/json"); e != nil {
		t.Errorf("valid: %v", e)
	}
	if e := mk(`{"a":"b","z":1}`, "application/json"); e == nil || e.Status != 400 {
		t.Errorf("unknown field: %v", e)
	}
	if e := mk(`{"a":"b"} {"a":"c"}`, "application/json"); e == nil {
		t.Error("trailing JSON must be rejected")
	}
	if e := mk(`{"a":"b"}`, "text/plain"); e == nil || e.Status != 415 {
		t.Errorf("wrong media type: %v", e)
	}
	if e := mk(`{"a":"b"}`, "application/json; charset=utf-8"); e != nil {
		t.Errorf("utf-8 charset allowed: %v", e)
	}
	if e := mk(`{"a":"b"}`, "application/json; charset=latin1"); e == nil {
		t.Error("latin1 must be rejected")
	}
	// Oversize.
	if e := mk(`{"a":"`+strings.Repeat("x", maxBodyBytes+100)+`"}`, "application/json"); e == nil || e.Status != 413 {
		t.Errorf("oversize: %v", e)
	}
}

func TestWriteErrorEnvelope(t *testing.T) {
	w := httptest.NewRecorder()
	WriteError(w, InvalidCredentials)
	if w.Code != 401 {
		t.Errorf("status: %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("content type: %q", ct)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Error("no-store missing")
	}
	body := w.Body.String()
	for _, want := range []string{`"code":"invalid_credentials"`, `"message":"Invalid username or password."`, `"error":`} {
		if !bytes.Contains([]byte(body), []byte(want)) {
			t.Errorf("body missing %s: %s", want, body)
		}
	}
}
