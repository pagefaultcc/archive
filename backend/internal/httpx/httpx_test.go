package httpx_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"archive/backend/internal/bootstrap"
	"archive/backend/internal/config"
	"archive/backend/internal/httpx"
	"archive/backend/internal/store"
)

const (
	origin  = "http://localhost:3000"
	rootPW  = "root-password-123"
	originH = "Origin"
)

type env struct {
	st  *store.Store
	srv *httptest.Server
}

var mux http.Handler

func testURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("TEST_DATABASE_URL")
	if u == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	return u
}

func setup(t *testing.T) *env {
	t.Helper()
	url := testURL(t)
	reset(t, url)
	if _, err := bootstrap.Run(context.Background(), url, bootstrap.Options{RootUsername: "rootadmin", RootPassword: rootPW}); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	st, err := store.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	o := config.MustParseOriginURL(origin)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := httpx.NewRouter(st, o, log)
	srv := httptest.NewUnstartedServer(h)
	srv.EnableHTTP2 = false
	srv.Start()
	t.Cleanup(func() {
		srv.Close()
		st.Close()
	})
	return &env{st: st, srv: srv}
}

func reset(t *testing.T, url string) {
	t.Helper()
	db, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Every migration-created table must be listed explicitly: two test
	// packages share TEST_DATABASE_URL, and goose re-runs from a clean
	// version state, so leftover tables collide with CREATE TABLE.
	for _, stmt := range []string{
		`DROP TABLE IF EXISTS audit_logs, sessions, role_permissions, user_roles, permissions, roles, users CASCADE`,
		`DROP TABLE IF EXISTS archive_cookie_domains, archive_credentials, cookie_validation_items, telegram_channels, telegram_blacklist, app_settings CASCADE`,
		`DROP TABLE IF EXISTS archives, archive_entries CASCADE`,
		`DROP TABLE IF EXISTS goose_db_version CASCADE`,
		`DROP FUNCTION IF EXISTS audit_logs_append_only() CASCADE`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("reset: %v", err)
		}
	}
}

type apiResp struct {
	status int
	body   []byte
	header http.Header
}

func (r apiResp) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("body %s: %v", r.body, err)
	}
	return m
}

func do(t *testing.T, srv *httptest.Server, method, path, body, originHdr, cookie string) apiResp {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, srv.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if originHdr != "" {
		req.Header.Set(originH, originHdr)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return apiResp{status: res.StatusCode, body: b, header: res.Header}
}

func login(t *testing.T, srv *httptest.Server, username, password string) apiResp {
	return do(t, srv, "POST", "/api/auth/login", `{"username":`+q(username)+`,"password":`+q(password)+`}`, origin, "")
}

func q(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func sessionCookieOf(t *testing.T, r apiResp) (string, string) {
	t.Helper()
	cookies := readSetCookies(r.header)
	for _, c := range cookies {
		if c.Name == "archive_session" {
			return c.Name + "=" + c.Value, c.Value
		}
	}
	t.Fatalf("no archive_session cookie in %v", r.header)
	return "", ""
}

func TestLoginSuccessAndContracts(t *testing.T) {
	e := setup(t)
	r := login(t, e.srv, "rootadmin", rootPW)
	if r.status != 200 {
		t.Fatalf("status %d body %s", r.status, r.body)
	}
	m := r.json(t)
	user := m["user"].(map[string]any)
	if user["username"] != "rootadmin" || user["isRoot"] != true {
		t.Fatalf("user: %v", user)
	}
	perms := user["permissions"].([]any)
	if len(perms) < 2 || !strings.Contains(r.bodyString(), "users:create") || !strings.Contains(r.bodyString(), "users:read") {
		t.Fatalf("permissions: %v", perms)
	}
	roles := user["roles"].([]any)
	if len(roles) != 1 || roles[0] != "root" {
		t.Fatalf("roles: %v", roles)
	}
	// Cookie attributes.
	c, val := sessionCookieOf(t, r)
	if c == "" || val == "" {
		return
	}
	for _, ck := range readSetCookies(r.header) {
		if ck.Name == "archive_session" {
			if !ck.HttpOnly || ck.SameSite != http.SameSiteLaxMode || ck.Path != "/" || ck.MaxAge != 604800 || ck.Secure {
				t.Fatalf("cookie attrs: %+v", ck)
			}
		}
	}
	// Distinct tokens across logins, fixed 43-char base64url (32 bytes).
	r2 := login(t, e.srv, "rootadmin", rootPW)
	_, val2 := sessionCookieOf(t, r2)
	if val == val2 {
		t.Fatal("session tokens must be distinct")
	}
	if len(val) != 43 {
		t.Fatalf("token length %d", len(val))
	}
}

func (r apiResp) bodyString() string { return string(r.body) }

func readSetCookies(h http.Header) []*http.Cookie {
	var out []*http.Cookie
	for _, line := range h.Values("Set-Cookie") {
		parts := strings.Split(line, "; ")
		if len(parts) == 0 {
			continue
		}
		kv := strings.SplitN(parts[0], "=", 2)
		if len(kv) != 2 {
			continue
		}
		c := &http.Cookie{Name: kv[0], Value: kv[1]}
		for _, p := range parts[1:] {
			pk, pv, _ := strings.Cut(p, "=")
			switch strings.ToLower(strings.TrimSpace(pk)) {
			case "httponly":
				c.HttpOnly = true
			case "secure":
				c.Secure = true
			case "path":
				c.Path = pv
			case "max-age":
				n := 0
				for _, ch := range pv {
					if ch < '0' || ch > '9' {
						n = -1
						break
					}
					n = n*10 + int(ch-'0')
				}
				c.MaxAge = n
			case "samesite":
				switch strings.ToLower(pv) {
				case "lax":
					c.SameSite = http.SameSiteLaxMode
				case "strict":
					c.SameSite = http.SameSiteStrictMode
				case "none":
					c.SameSite = http.SameSiteNoneMode
				}
			}
		}
		out = append(out, c)
	}
	return out
}

func TestLoginFailures(t *testing.T) {
	e := setup(t)
	r := login(t, e.srv, "rootadmin", "wrong-password")
	if r.status != 401 {
		t.Fatalf("status %d", r.status)
	}
	m := r.json(t)
	if m["error"].(map[string]any)["code"] != "invalid_credentials" {
		t.Fatalf("envelope: %s", r.body)
	}
	r2 := login(t, e.srv, "nouser", "whatever")
	if r2.status != 401 || string(r2.body) != string(r.body) {
		t.Fatalf("unknown user body differs: %s vs %s", r2.body, r.body)
	}
	// Validation.
	r3 := login(t, e.srv, "ab", "x")
	if r3.status != 400 {
		t.Fatalf("short username: %d", r3.status)
	}
	r4 := do(t, e.srv, "POST", "/api/auth/login", `{"user":"x"}`, origin, "")
	if r4.status != 400 {
		t.Fatalf("malformed body: %d", r4.status)
	}
	r5 := do(t, e.srv, "POST", "/api/auth/login", `{"username":"x"}`, origin, "")
	if r5.status != 400 {
		t.Fatalf("missing password: %d", r5.status)
	}
}

func TestMeAndLogout(t *testing.T) {
	e := setup(t)
	r := login(t, e.srv, "rootadmin", rootPW)
	cookie, _ := sessionCookieOf(t, r)

	me := do(t, e.srv, "GET", "/api/auth/me", "", "", cookie)
	if me.status != 200 {
		t.Fatalf("me: %d %s", me.status, me.body)
	}
	if cc := me.header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("me cache-control %q", cc)
	}

	lo := do(t, e.srv, "POST", "/api/auth/logout", "", origin, cookie)
	if lo.status != 204 {
		t.Fatalf("logout: %d", lo.status)
	}
	// Cookie cleared.
	cleared := readSetCookies(lo.header)
	found := false
	for _, c := range cleared {
		if c.Name == "archive_session" && c.MaxAge <= 0 && c.Value == "" {
			found = true
		}
	}
	if !found {
		t.Fatal("clearing cookie missing")
	}
	me2 := do(t, e.srv, "GET", "/api/auth/me", "", "", cookie)
	if me2.status != 401 {
		t.Fatalf("me after logout: %d", me2.status)
	}
	// 401 mapping.
	if !strings.Contains(me2.bodyString(), "unauthenticated") {
		t.Fatalf("401 body: %s", me2.body)
	}
}

func TestSessionTamperedAndExpired(t *testing.T) {
	e := setup(t)
	if s := do(t, e.srv, "GET", "/api/auth/me", "", "", "archive_session=garbage"); s.status != 401 {
		t.Fatalf("malformed cookie: %d", s.status)
	}
	// Expired session row: insert directly with digest of a known token.
	url := testURL(t)
	db, _ := sql.Open("pgx", url)
	defer db.Close()
	token := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	rawToken, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		t.Fatal(err)
	}
	d := sha256.Sum256(rawToken)
	digestHex := hex.EncodeToString(d[:])
	var uid string
	if err := db.QueryRow(`SELECT id::text FROM users WHERE is_root`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec(`INSERT INTO sessions (token_digest, user_id, expires_at) VALUES ($1, (SELECT id FROM users WHERE is_root), now() - interval '1 hour')`,
		digestHex)
	if s := do(t, e.srv, "GET", "/api/auth/me", "", "", "archive_session="+token); s.status != 401 {
		t.Fatalf("expired: %d", s.status)
	}
	var count int
	_ = db.QueryRow(`SELECT count(*) FROM sessions WHERE token_digest = $1`, digestHex).Scan(&count)
	if count != 0 {
		t.Fatal("expired row not deleted")
	}
}

func TestUsersRoutesPermissions(t *testing.T) {
	e := setup(t)
	r := login(t, e.srv, "rootadmin", rootPW)
	cookie, _ := sessionCookieOf(t, r)

	// List.
	l := do(t, e.srv, "GET", "/api/users", "", "", cookie)
	if l.status != 200 {
		t.Fatalf("list: %d %s", l.status, l.body)
	}
	if !strings.Contains(l.bodyString(), `"isRoot":true`) {
		t.Fatalf("list body: %s", l.body)
	}

	// Create valid.
	c := do(t, e.srv, "POST", "/api/users", `{"username":"operator_1","password":"ArchiveUser!2026"}`, origin, cookie)
	if c.status != 201 {
		t.Fatalf("create: %d %s", c.status, c.body)
	}
	cu := c.json(t)["user"].(map[string]any)
	if cu["isRoot"] != false {
		t.Fatal("new user must not be root")
	}
	if cu["createdAt"] == nil {
		t.Fatal("createdAt missing")
	}

	// Duplicate case-insensitive -> 409.
	dup := do(t, e.srv, "POST", "/api/users", `{"username":"OPERATOR_1","password":"ArchiveUser!2026"}`, origin, cookie)
	if dup.status != 409 || !strings.Contains(dup.bodyString(), "username_taken") {
		t.Fatalf("dup: %d %s", dup.status, dup.body)
	}

	// Field errors.
	f := do(t, e.srv, "POST", "/api/users", `{"username":"a","password":"short"}`, origin, cookie)
	if f.status != 400 || !strings.Contains(f.bodyString(), "fields") {
		t.Fatalf("fields: %d %s", f.status, f.body)
	}
	if !strings.Contains(f.bodyString(), "Use 3 to 64 letters") || !strings.Contains(f.bodyString(), "Use 12 to 128 characters.") {
		t.Fatalf("field messages: %s", f.body)
	}

	// Unknown fields rejected.
	u := do(t, e.srv, "POST", "/api/users", `{"username":"operator_2","password":"ArchiveUser!2026","isRoot":true}`, origin, cookie)
	if u.status != 400 {
		t.Fatalf("isRoot accepted: %d", u.status)
	}
	ro := do(t, e.srv, "POST", "/api/users", `{"username":"operator_3","password":"ArchiveUser!2026","roles":["root"]}`, origin, cookie)
	if ro.status != 400 {
		t.Fatalf("roles accepted: %d", ro.status)
	}

	// Media type.
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/users", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Cookie", cookie)
	req.Header.Set(originH, origin)
	res, _ := e.srv.Client().Do(req)
	if res.StatusCode != 415 {
		t.Fatalf("media: %d", res.StatusCode)
	}
	res.Body.Close()
}

func TestOrdinaryUserDenied(t *testing.T) {
	e := setup(t)
	rl := login(t, e.srv, "rootadmin", rootPW)
	cookie, _ := sessionCookieOf(t, rl)
	if s := do(t, e.srv, "POST", "/api/users", `{"username":"plain_user_1","password":"Password!12345"}`, origin, cookie); s.status != 201 {
		t.Fatalf("setup create: %d %s", s.status, s.body)
	}
	pu := login(t, e.srv, "plain_user_1", "Password!12345")
	var loginBody struct {
		User struct {
			Permissions []string `json:"permissions"`
		} `json:"user"`
	}
	if err := json.Unmarshal(pu.body, &loginBody); err != nil {
		t.Fatal(err)
	}
	if loginBody.User.Permissions == nil || len(loginBody.User.Permissions) != 0 {
		t.Fatalf("ordinary permissions must be an empty array: %s", pu.body)
	}
	pcookie, _ := sessionCookieOf(t, pu)

	if s := do(t, e.srv, "GET", "/api/users", "", "", pcookie); s.status != 403 {
		t.Fatalf("ordinary GET: %d", s.status)
	}
	if s := do(t, e.srv, "POST", "/api/users", `{"username":"plain_user_2","password":"Password!12345"}`, origin, pcookie); s.status != 403 {
		t.Fatalf("ordinary POST: %d", s.status)
	}
	if s := do(t, e.srv, "GET", "/api/users", "", "", ""); s.status != 401 {
		t.Fatalf("anonymous: %d", s.status)
	}
}

func TestOriginEnforced(t *testing.T) {
	e := setup(t)
	rl := login(t, e.srv, "rootadmin", rootPW)
	cookie, _ := sessionCookieOf(t, rl)
	body := `{"username":"op_user_x1","password":"Password!12345"}`

	// Cross-origin denied.
	bad := do(t, e.srv, "POST", "/api/users", body, "http://example.test", cookie)
	if bad.status != 403 {
		t.Fatalf("cross-origin: %d", bad.status)
	}
	// Normal proxied request succeeds.
	ok := do(t, e.srv, "POST", "/api/users", body, origin, cookie)
	if ok.status != 201 {
		t.Fatalf("same-origin: %d %s", ok.status, ok.body)
	}
	_ = rl
	_ = cookie
	_ = body
	_ = e
}

func TestNoStoreHeaders(t *testing.T) {
	e := setup(t)
	r := login(t, e.srv, "rootadmin", rootPW)
	cookie, _ := sessionCookieOf(t, r)
	me := do(t, e.srv, "GET", "/api/auth/me", "", "", cookie)
	if cc := me.header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("cache-control: %q", cc)
	}
	ls := do(t, e.srv, "GET", "/api/users", "", "", cookie)
	if cc := ls.header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("users cache-control: %q", cc)
	}
}

func TestSessionCleanup(t *testing.T) {
	e := setup(t)
	url := testURL(t)
	db, _ := sql.Open("pgx", url)
	defer db.Close()
	var uid string
	if err := db.QueryRow(`SELECT id::text FROM users WHERE is_root`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO sessions (token_digest, user_id, expires_at) VALUES ('expired', $1, now() - interval '1 hour')`, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.DeleteExpiredSessions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var count int
	_ = db.QueryRow(`SELECT count(*) FROM sessions WHERE expires_at <= now()`).Scan(&count)
	if count != 0 {
		t.Fatal("expired sessions not purged")
	}
}

func TestReadiness(t *testing.T) {
	e := setup(t)
	req, _ := http.NewRequest("GET", e.srv.URL+"/health/ready", nil)
	res, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(res.Body).Decode(&m)
	if res.StatusCode != 200 || m["status"] != "ok" {
		t.Fatalf("ready: %d %v", res.StatusCode, m)
	}
}

// --- shared harness pieces ---

var shared struct {
	st *store.Store
}

func withStore(e *env) *store.Store { return e.st }

func init() {
	_ = strings.TrimSpace
	_ = httpx.RequestID
	_ = bootstrap.Options{}
}
