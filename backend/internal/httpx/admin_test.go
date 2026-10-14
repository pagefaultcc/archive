package httpx_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

type adminEnv struct {
	*env
	cookie string
}

func newAdmin(t *testing.T) *adminEnv {
	t.Helper()
	e := setup(t)
	rl := login(t, e.srv, "rootadmin", rootPW)
	if rl.status != 200 {
		t.Fatalf("root login: %d %s", rl.status, rl.body)
	}
	cookie, _ := sessionCookieOf(t, rl)
	return &adminEnv{env: e, cookie: cookie}
}

func (a *adminEnv) user(t *testing.T, name, pw string) map[string]any {
	t.Helper()
	r := do(t, a.srv, "POST", "/api/users", `{"username":`+q(name)+`,"password":`+q(pw)+`}`, origin, a.cookie)
	if r.status != 201 {
		t.Fatalf("create %s: %d %s", name, r.status, r.body)
	}
	return r.json(t)["user"].(map[string]any)
}

func (a *adminEnv) userID(t *testing.T, name string) string {
	t.Helper()
	r := do(t, a.srv, "GET", "/api/users", "", "", a.cookie)
	for _, u := range r.json(t)["users"].([]any) {
		m := u.(map[string]any)
		if m["username"] == name {
			return m["id"].(string)
		}
	}
	t.Fatalf("user %s not in list", name)
	return ""
}

func (a *adminEnv) do(t *testing.T, method, path, body string) apiResp {
	return do(t, a.srv, method, path, body, origin, a.cookie)
}

func errCode(t *testing.T, r apiResp) string {
	t.Helper()
	m := r.json(t)
	e, _ := m["error"].(map[string]any)
	if e == nil {
		t.Fatalf("no error envelope: %s", r.body)
	}
	c, _ := e["code"].(string)
	return c
}

func TestUsersIncludeStatus(t *testing.T) {
	a := newAdmin(t)
	a.user(t, "status_u1", "Password!12345")
	l := a.do(t, "GET", "/api/users", "")
	if l.status != 200 {
		t.Fatalf("list: %d", l.status)
	}
	found := false
	for _, u := range l.json(t)["users"].([]any) {
		m := u.(map[string]any)
		if m["status"] == nil {
			t.Fatalf("status missing in %v", m)
		}
		if m["username"] == "status_u1" {
			found = true
			if m["status"] != "active" {
				t.Fatalf("status: %v", m["status"])
			}
		}
	}
	if !found {
		t.Fatal("created user missing from list")
	}
}

func TestGetUser(t *testing.T) {
	a := newAdmin(t)
	u := a.user(t, "get_u1", "Password!12345")
	id := u["id"].(string)
	r := a.do(t, "GET", "/api/users/"+id, "")
	if r.status != 200 {
		t.Fatalf("get: %d %s", r.status, r.body)
	}
	m := r.json(t)["user"].(map[string]any)
	if m["username"] != "get_u1" || m["status"] != "active" || m["isRoot"] != false {
		t.Fatalf("user body: %v", m)
	}
	if nf := a.do(t, "GET", "/api/users/00000000-0000-0000-0000-000000000000", ""); nf.status != 404 {
		t.Fatalf("unknown user: %d", nf.status)
	}
}

func TestRootImmutability(t *testing.T) {
	a := newAdmin(t)
	rootID := a.userID(t, "rootadmin")

	if r := a.do(t, "PATCH", "/api/users/"+rootID, `{"username":"newroot"}`); r.status != 409 || errCode(t, r) != "immutable_target" {
		t.Fatalf("rename root: %d %s", r.status, r.body)
	}
	if r := a.do(t, "PATCH", "/api/users/"+rootID+"/password", `{"password":"NewPassword!123"}`); r.status != 409 || errCode(t, r) != "immutable_target" {
		t.Fatalf("reset root password: %d %s", r.status, r.body)
	}
	if r := a.do(t, "PATCH", "/api/users/"+rootID+"/suspension", `{"suspended":true}`); r.status != 409 || errCode(t, r) != "immutable_target" {
		t.Fatalf("suspend root: %d %s", r.status, r.body)
	}
	if r := a.do(t, "DELETE", "/api/users/"+rootID, ""); r.status != 409 || errCode(t, r) != "immutable_target" {
		t.Fatalf("delete root: %d %s", r.status, r.body)
	}
	// Root account is unchanged.
	if r := login(t, a.srv, "rootadmin", rootPW); r.status != 200 {
		t.Fatalf("root login after attempts: %d", r.status)
	}
	l := a.do(t, "GET", "/api/users", "")
	for _, u := range l.json(t)["users"].([]any) {
		if u.(map[string]any)["username"] == "newroot" {
			t.Fatal("root was renamed")
		}
	}
}

func TestUpdateUsername(t *testing.T) {
	a := newAdmin(t)
	u := a.user(t, "rename_u1", "Password!12345")
	id := u["id"].(string)
	r := a.do(t, "PATCH", "/api/users/"+id, `{"username":"rename_u2"}`)
	if r.status != 200 {
		t.Fatalf("rename: %d %s", r.status, r.body)
	}
	if m := r.json(t)["user"].(map[string]any); m["username"] != "rename_u2" {
		t.Fatalf("renamed: %v", m)
	}
	// Renaming onto a taken name conflicts case-insensitively.
	a.user(t, "rename_u3", "Password!12345")
	c := a.do(t, "PATCH", "/api/users/"+id, `{"username":"RENAME_U3"}`)
	if c.status != 409 || errCode(t, c) != "username_taken" {
		t.Fatalf("rename collision: %d %s", c.status, c.body)
	}
	// Validation.
	v := a.do(t, "PATCH", "/api/users/"+id, `{"username":"x"}`)
	if v.status != 400 {
		t.Fatalf("invalid rename: %d", v.status)
	}
	// Unknown user.
	nf := a.do(t, "PATCH", "/api/users/00000000-0000-0000-0000-000000000000", `{"username":"rename_u4"}`)
	if nf.status != 404 || errCode(t, nf) != "not_found" {
		t.Fatalf("unknown target: %d %s", nf.status, nf.body)
	}
}

func TestResetPasswordRevokesSessions(t *testing.T) {
	a := newAdmin(t)
	a.user(t, "pw_u2", "Password!12345")
	ulogin := login(t, a.srv, "pw_u2", "Password!12345")
	if ulogin.status != 200 {
		t.Fatalf("user login: %d %s", ulogin.status, ulogin.body)
	}
	uid := a.userID(t, "pw_u2")
	userCookie, _ := sessionCookieOf(t, ulogin)
	if me := do(t, a.srv, "GET", "/api/auth/me", "", "", userCookie); me.status != 200 {
		t.Fatalf("user me: %d", me.status)
	}

	r := a.do(t, "PATCH", "/api/users/"+uid+"/password", `{"password":"NewPassword!2026"}`)
	if r.status != 200 {
		t.Fatalf("reset: %d %s", r.status, r.body)
	}
	// Old session revoked.
	if me := do(t, a.srv, "GET", "/api/auth/me", "", "", userCookie); me.status != 401 {
		t.Fatalf("session must be revoked after password reset: %d", me.status)
	}
	// Old password no longer works; new one does.
	if r := login(t, a.srv, "pw_u2", "Password!12345"); r.status != 401 {
		t.Fatalf("old password must fail: %d", r.status)
	}
	if r := login(t, a.srv, "pw_u2", "NewPassword!2026"); r.status != 200 {
		t.Fatalf("new password: %d %s", r.status, r.body)
	}
	// Validation.
	v := a.do(t, "PATCH", "/api/users/"+uid+"/password", `{"password":"short"}`)
	if v.status != 400 {
		t.Fatalf("short password: %d", v.status)
	}
}

func TestSuspendAndReactivate(t *testing.T) {
	a := newAdmin(t)
	a.user(t, "susp_u1", "Password!12345")
	ul := login(t, a.srv, "susp_u1", "Password!12345")
	userCookie, _ := sessionCookieOf(t, ul)
	uid := a.userID(t, "susp_u1")

	r := a.do(t, "PATCH", "/api/users/"+uid+"/suspension", `{"suspended":true}`)
	if r.status != 200 {
		t.Fatalf("suspend: %d %s", r.status, r.body)
	}
	if m := r.json(t)["user"].(map[string]any); m["status"] != "suspended" {
		t.Fatalf("status: %v", m["status"])
	}
	// Existing session rejected.
	if me := do(t, a.srv, "GET", "/api/auth/me", "", "", userCookie); me.status != 401 {
		t.Fatalf("suspended session: %d", me.status)
	}
	// Suspended login is byte-identical to invalid credentials.
	wrong := login(t, a.srv, "susp_u1", "totally-wrong-pass")
	susp := login(t, a.srv, "susp_u1", "Password!12345")
	if susp.status != 401 || susp.bodyString() != wrong.bodyString() {
		t.Fatalf("suspended login must look like invalid credentials: %d %s", susp.status, susp.body)
	}
	// Reactivate.
	ra := a.do(t, "PATCH", "/api/users/"+uid+"/suspension", `{"suspended":false}`)
	if ra.status != 200 {
		t.Fatalf("reactivate: %d %s", ra.status, ra.body)
	}
	if m := ra.json(t)["user"].(map[string]any); m["status"] != "active" {
		t.Fatalf("reactivated status: %v", m["status"])
	}
	if r2 := login(t, a.srv, "susp_u1", "Password!12345"); r2.status != 200 {
		t.Fatalf("login after reactivate: %d %s", r2.status, r2.body)
	}
}

func TestSoftDeleteAndRestore(t *testing.T) {
	a := newAdmin(t)
	a.user(t, "del_u1", "Password!12345")
	ul := login(t, a.srv, "del_u1", "Password!12345")
	userCookie, _ := sessionCookieOf(t, ul)
	uid := a.userID(t, "del_u1")

	d := a.do(t, "DELETE", "/api/users/"+uid, "")
	if d.status != 204 {
		t.Fatalf("delete: %d %s", d.status, d.body)
	}
	// Gone from list and get.
	l := a.do(t, "GET", "/api/users", "")
	for _, u := range l.json(t)["users"].([]any) {
		if u.(map[string]any)["username"] == "del_u1" {
			t.Fatal("deleted user still listed")
		}
	}
	if g := a.do(t, "GET", "/api/users/"+uid, ""); g.status != 404 {
		t.Fatalf("get deleted: %d", g.status)
	}
	// Session revoked.
	if me := do(t, a.srv, "GET", "/api/auth/me", "", "", userCookie); me.status != 401 {
		t.Fatalf("deleted user session must be revoked: %d", me.status)
	}
	// Login rejected.
	if r := login(t, a.srv, "del_u1", "Password!12345"); r.status != 401 {
		t.Fatalf("deleted login: %d", r.status)
	}
	// Username remains reserved.
	if c := a.do(t, "POST", "/api/users", `{"username":"DEL_U1","password":"Password!12345"}`); c.status != 409 {
		t.Fatalf("reserved username: %d %s", c.status, c.body)
	}
	// Restore.
	rs := a.do(t, "POST", "/api/users/"+uid+"/restore", "")
	if rs.status != 200 {
		t.Fatalf("restore: %d %s", rs.status, rs.body)
	}
	if m := rs.json(t)["user"].(map[string]any); m["status"] != "active" {
		t.Fatalf("restored status: %v", m["status"])
	}
	if r := login(t, a.srv, "del_u1", "Password!12345"); r.status != 200 {
		t.Fatalf("login after restore: %d %s", r.status, r.body)
	}
	// Restoring a live user is 404.
	if nf := a.do(t, "POST", "/api/users/"+uid+"/restore", ""); nf.status != 404 {
		t.Fatalf("restore live user: %d %s", nf.status, nf.body)
	}
}

func TestSessionListAndRevocation(t *testing.T) {
	a := newAdmin(t)
	a.user(t, "sess_u1", "Password!12345")
	ul := login(t, a.srv, "sess_u1", "Password!12345")
	userCookie, _ := sessionCookieOf(t, ul)
	uid := a.userID(t, "sess_u1")

	ls := a.do(t, "GET", "/api/users/"+uid+"/sessions", "")
	if ls.status != 200 {
		t.Fatalf("list sessions: %d %s", ls.status, ls.body)
	}
	var sessions struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(ls.body, &sessions); err != nil {
		t.Fatal(err)
	}
	if len(sessions.Sessions) != 1 {
		t.Fatalf("expected 1 session: %s", ls.body)
	}
	s := sessions.Sessions[0]
	if s["id"] == nil || s["createdAt"] == nil || s["expiresAt"] == nil {
		t.Fatalf("session view: %v", s)
	}
	body := ls.bodyString()
	if strings.Contains(body, "token") || strings.Contains(body, "digest") {
		t.Fatalf("no token material may appear: %s", body)
	}

	// Second session, then revoke all.
	if _, ok := sessionCookieOf(t, login(t, a.srv, "sess_u1", "Password!12345")); ok == "" {
		t.Fatal("second login missing cookie")
	}
	if d := a.do(t, "DELETE", "/api/users/"+uid+"/sessions", ""); d.status != 204 {
		t.Fatalf("revoke all: %d %s", d.status, d.body)
	}
	if me := do(t, a.srv, "GET", "/api/auth/me", "", "", userCookie); me.status != 401 {
		t.Fatalf("sessions must be revoked: %d", me.status)
	}
	if l2 := a.do(t, "GET", "/api/users/"+uid+"/sessions", ""); len(l2.json(t)["sessions"].([]any)) != 0 {
		t.Fatalf("sessions after revoke all: %s", l2.body)
	}
}

func TestRevokeSingleSession(t *testing.T) {
	a := newAdmin(t)
	a.user(t, "rsess_u1", "Password!12345")
	uid := a.userID(t, "rsess_u1")
	c1, _ := sessionCookieOf(t, login(t, a.srv, "rsess_u1", "Password!12345"))
	c2, _ := sessionCookieOf(t, login(t, a.srv, "rsess_u1", "Password!12345"))
	ls := a.do(t, "GET", "/api/users/"+uid+"/sessions", "")
	sessions := ls.json(t)["sessions"].([]any)
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions: %s", ls.body)
	}
	sid := sessions[0].(map[string]any)["id"].(string)
	if d := a.do(t, "DELETE", "/api/users/"+uid+"/sessions/"+sid, ""); d.status != 204 {
		t.Fatalf("revoke single: %d %s", d.status, d.body)
	}
	// Exactly one of the two cookies stays valid.
	s1 := do(t, a.srv, "GET", "/api/auth/me", "", "", c1).status
	s2 := do(t, a.srv, "GET", "/api/auth/me", "", "", c2).status
	if (s1 == 200) == (s2 == 200) {
		t.Fatalf("expected one live and one revoked session, got %d and %d", s1, s2)
	}
}

func TestRolesListAndInvariants(t *testing.T) {
	a := newAdmin(t)
	l := a.do(t, "GET", "/api/roles", "")
	if l.status != 200 {
		t.Fatalf("list roles: %d %s", l.status, l.body)
	}
	var rootID string
	var rootPerms []any
	for _, r := range l.json(t)["roles"].([]any) {
		m := r.(map[string]any)
		if m["name"] == "root" {
			rootID = m["id"].(string)
			if m["protected"] != true {
				t.Fatalf("root must be protected: %v", m)
			}
			p, ok := m["permissions"].([]any)
			if !ok || len(p) == 0 {
				t.Fatalf("root must hold permissions: %v", m)
			}
			rootPerms = p
		}
		if m["name"] == "user" && m["protected"] != true {
			t.Fatalf("user role must be protected: %v", m)
		}
	}
	if len(rootPerms) == 0 {
		t.Fatal("root permissions missing")
	}
	// Protected roles cannot be renamed or deleted.
	if r := a.do(t, "PUT", "/api/roles/"+rootID, `{"name":"super","label":"Super","permissions":["users:read"]}`); r.status != 409 || errCode(t, r) != "immutable_target" {
		t.Fatalf("rename protected role: %d %s", r.status, r.body)
	}
	if r := a.do(t, "DELETE", "/api/roles/"+rootID, ""); r.status != 409 || errCode(t, r) != "immutable_target" {
		t.Fatalf("delete protected role: %d %s", r.status, r.body)
	}
	// Custom role lifecycle + user role assignment + root role removal invariant.
	cr := a.do(t, "POST", "/api/roles", `{"name":"auditor","label":"Auditor","permissions":["audit:read","users:read"]}`)
	if cr.status != 201 {
		t.Fatalf("create role: %d %s", cr.status, cr.body)
	}
	roleID := cr.json(t)["role"].(map[string]any)["id"].(string)
	up := a.do(t, "PUT", "/api/roles/"+roleID, `{"name":"auditor_ro","label":"Auditor ReadOnly","permissions":["audit:read"]}`)
	if up.status != 200 {
		t.Fatalf("update role: %d %s", up.status, up.body)
	}
	u := a.user(t, "role_target", "Password!12345")
	uid := u["id"].(string)
	if ar := a.do(t, "PUT", "/api/users/"+uid+"/roles/"+roleID, ""); ar.status != 200 {
		t.Fatalf("assign role: %d %s", ar.status, ar.body)
	}
	if rr := a.do(t, "DELETE", "/api/users/"+uid+"/roles/"+roleID, ""); rr.status != 200 {
		t.Fatalf("remove role: %d %s", rr.status, rr.body)
	}
	rootUserID := a.userID(t, "rootadmin")
	if br := a.do(t, "DELETE", "/api/users/"+rootUserID+"/roles/"+rootID, ""); br.status != 409 || errCode(t, br) != "immutable_target" {
		t.Fatalf("removing root role from root user must fail: %d %s", br.status, br.body)
	}
	if dr := a.do(t, "DELETE", "/api/roles/"+roleID, ""); dr.status != 204 {
		t.Fatalf("delete custom role: %d %s", dr.status, dr.body)
	}
}

func TestPermissionsList(t *testing.T) {
	a := newAdmin(t)
	r := a.do(t, "GET", "/api/permissions", "")
	if r.status != 200 {
		t.Fatalf("permissions: %d %s", r.status, r.body)
	}
	body := r.bodyString()
	for _, want := range []string{"users:read", "users:create", "users:manage_roles", "audit:read"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing permission %s in %s", want, body)
		}
	}
}

func TestAuditLogPaginationAndFilters(t *testing.T) {
	a := newAdmin(t)
	for i := range 3 {
		a.user(t, fmt.Sprintf("audit_pg_%d", i), "Password!12345")
	}

	l := a.do(t, "GET", "/api/audit", "")
	if l.status != 200 {
		t.Fatalf("audit: %d %s", l.status, l.body)
	}
	var page struct {
		Entries    []map[string]any `json:"entries"`
		NextCursor *string          `json:"nextCursor"`
		HasMore    bool             `json:"hasMore"`
	}
	if err := json.Unmarshal(l.body, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) < 3 {
		t.Fatalf("expected audit entries for creations: %s", l.body)
	}
	for _, e := range page.Entries {
		if e["action"] == "" || e["createdAt"] == nil {
			t.Fatalf("audit entry missing fields: %v", e)
		}
		if e["actorId"] == nil {
			t.Fatalf("actor missing: %v", e)
		}
	}
	// Filter by action.
	f := a.do(t, "GET", "/api/audit?action=user.created", "")
	if f.status != 200 {
		t.Fatalf("filtered audit: %d", f.status)
	}
	for _, e := range f.json(t)["entries"].([]any) {
		if e.(map[string]any)["action"] != "user.created" {
			t.Fatalf("filter leaked other actions: %s", f.body)
		}
	}
	// Cursor pagination: limit=1 walks forward without repeats.
	var seen []float64
	cursor := ""
	for range 4 {
		u := "/api/audit?limit=1"
		if cursor != "" {
			u += "&cursor=" + cursor
		}
		p := a.do(t, "GET", u, "")
		if p.status != 200 {
			t.Fatalf("page: %d %s", p.status, p.body)
		}
		var pg struct {
			Entries    []map[string]any `json:"entries"`
			NextCursor *string          `json:"nextCursor"`
			HasMore    bool             `json:"hasMore"`
		}
		if err := json.Unmarshal(p.body, &pg); err != nil {
			t.Fatal(err)
		}
		if len(pg.Entries) > 0 {
			id, _ := pg.Entries[0]["id"].(float64)
			seen = append(seen, id)
		}
		if !pg.HasMore {
			break
		}
		if pg.NextCursor == nil {
			t.Fatal("hasMore without nextCursor")
		}
		cursor = *pg.NextCursor
	}
	for i := range len(seen) - 1 {
		if seen[i] <= seen[i+1] {
			t.Fatalf("cursor order broken: %v", seen)
		}
	}
	if len(seen) < 3 {
		t.Fatalf("pagination walked only %d pages: %v", len(seen), seen)
	}
	// Invalid cursor/limit.
	if r := a.do(t, "GET", "/api/audit?cursor=abc", ""); r.status != 400 {
		t.Fatalf("bad cursor: %d", r.status)
	}
	if r := a.do(t, "GET", "/api/audit?limit=99", ""); r.status != 400 {
		t.Fatalf("bad limit: %d", r.status)
	}
}

func TestPermissionsGateAdminRoutes(t *testing.T) {
	a := newAdmin(t)
	a.user(t, "plain_guard", "Password!12345")
	ul := login(t, a.srv, "plain_guard", "Password!12345")
	pcookie, _ := sessionCookieOf(t, ul)
	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/api/users", ""},
		{"GET", "/api/roles", ""},
		{"GET", "/api/permissions", ""},
		{"GET", "/api/audit", ""},
		{"POST", "/api/roles", `{"name":"guard_r1","label":"Guard","permissions":[]}`},
	} {
		r := do(t, a.srv, tc.method, tc.path, tc.body, origin, pcookie)
		if r.status != 403 {
			t.Fatalf("ordinary user %s %s: %d %s", tc.method, tc.path, r.status, r.body)
		}
	}
	// Anonymous.
	if r := do(t, a.srv, "GET", "/api/roles", "", origin, ""); r.status != 401 {
		t.Fatalf("anonymous roles: %d", r.status)
	}
}

func TestAuditAppendOnlyAtDBLevel(t *testing.T) {
	a := newAdmin(t)
	a.user(t, "audit_db_u1", "Password!12345")
	url := testURL(t)
	db, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM audit_logs`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("expected audit rows")
	}
	if _, err := db.Exec(`UPDATE audit_logs SET action = 'tampered'`); err == nil {
		t.Fatal("audit_logs must reject updates")
	}
	if _, err := db.Exec(`DELETE FROM audit_logs`); err == nil {
		t.Fatal("audit_logs must reject deletes")
	}
}

func TestAuditRowsForAllMutations(t *testing.T) {
	a := newAdmin(t)
	u := a.user(t, "audit_ops", "Password!12345")
	id := u["id"].(string)

	a.do(t, "PATCH", "/api/users/"+id, `{"username":"audit_ops2"}`)
	a.do(t, "PATCH", "/api/users/"+id+"/suspension", `{"suspended":true}`)
	a.do(t, "DELETE", "/api/users/"+id, "")
	a.do(t, "POST", "/api/users/"+id+"/restore", "")

	l := a.do(t, "GET", "/api/audit", "")
	body := l.bodyString()
	for _, want := range []string{"user.username_updated", "user.suspended", "user.restored", "user.deleted", "user.created"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing audit action %s in %s", want, body)
		}
	}
}

func TestAdminOriginEnforced(t *testing.T) {
	a := newAdmin(t)
	u := a.user(t, "origin_g", "Password!12345")
	id := u["id"].(string)
	r := do(t, a.srv, "PATCH", "/api/users/"+id+"/suspension", `{"suspended":true}`, "http://example.test", a.cookie)
	if r.status != 403 {
		t.Fatalf("cross-origin mutation: %d %s", r.status, r.body)
	}
}

func TestNotFoundCode(t *testing.T) {
	a := newAdmin(t)
	if r := a.do(t, "GET", "/api/nonexistent", ""); r.status != 404 || errCode(t, r) != "not_found" {
		t.Fatalf("unknown path: %d %s", r.status, r.body)
	}

}
