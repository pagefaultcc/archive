package httpx_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// archiveEnv pairs the shared test env with a root session cookie and a
// per-test archive storage directory.
type archiveEnv struct {
	*env
	cookie string
}

func newArchiveEnv(t *testing.T) *archiveEnv {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("ARCHIVE_STORAGE_DIR", dir)
	e := setup(t)
	rl := login(t, e.srv, "rootadmin", rootPW)
	if rl.status != 200 {
		t.Fatalf("root login: %d %s", rl.status, rl.body)
	}
	cookie, _ := sessionCookieOf(t, rl)
	return &archiveEnv{env: e, cookie: cookie}
}

// makeZip writes a plain (unencrypted) zip with the given file tree.
func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// upload posts a multipart archive upload as root.
func (a *archiveEnv) upload(t *testing.T, filename string, content []byte, password string) apiResp {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", `form-data; name="file"; filename="`+filename+`"`)
	h.Set("Content-Type", "application/octet-stream")
	fw, err := mw.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatal(err)
	}
	if password != "" {
		if err := mw.WriteField("password", password); err != nil {
			t.Fatal(err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", a.srv.URL+"/api/archives", &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set(originH, origin)
	req.Header.Set("Cookie", a.cookie)
	res, err := a.srv.Client().Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return apiResp{status: res.StatusCode, body: b, header: res.Header}
}

func (a *archiveEnv) detail(t *testing.T, id string, params map[string]string) apiResp {
	t.Helper()
	qs := ""
	for k, v := range params {
		sep := "&"
		if qs == "" {
			sep = "?"
		}
		qs += sep + k + "=" + v
	}
	return do(t, a.srv, "GET", "/api/archives/"+id+qs, "", origin, a.cookie)
}

func TestArchiveUploadAndBrowse(t *testing.T) {
	a := newArchiveEnv(t)
	content := makeZip(t, map[string]string{
		"docs/readme.md":       "hello",
		"docs/guide/intro.txt": "intro",
		"top.txt":              "top",
	})

	res := a.upload(t, "test.zip", content, "")
	if res.status != 201 {
		t.Fatalf("upload status %d: %s", res.status, res.body)
	}
	var created struct {
		Archive struct {
			ID        string `json:"id"`
			Status    string `json:"status"`
			FileCount int    `json:"fileCount"`
			DirCount  int    `json:"dirCount"`
			Format    string `json:"format"`
		} `json:"archive"`
		PasswordRequired bool `json:"passwordRequired"`
	}
	if err := json.Unmarshal(res.body, &created); err != nil {
		t.Fatalf("%s: %v", res.body, err)
	}
	if created.PasswordRequired {
		t.Fatal("plain zip must not require a password")
	}
	if created.Archive.Status != "indexed" || created.Archive.Format != "zip" {
		t.Fatalf("archive = %+v", created.Archive)
	}
	if created.Archive.FileCount != 3 {
		t.Fatalf("fileCount = %d, want 3", created.Archive.FileCount)
	}
	if created.Archive.DirCount < 2 {
		t.Fatalf("dirCount = %d, want >= 2 (docs, docs/guide)", created.Archive.DirCount)
	}
	id := created.Archive.ID

	var detail struct {
		Entries []struct {
			Path  string `json:"path"`
			Name  string `json:"name"`
			IsDir bool   `json:"isDir"`
		} `json:"entries"`
		ParentPath string `json:"parentPath"`
		Query      string `json:"query"`
	}

	// Root browse: only top-level items.
	res = a.detail(t, id, nil)
	if res.status != 200 {
		t.Fatalf("detail status %d: %s", res.status, res.body)
	}
	if err := json.Unmarshal(res.body, &detail); err != nil {
		t.Fatal(err)
	}
	if detail.ParentPath != "" {
		t.Fatalf("parentPath = %q", detail.ParentPath)
	}
	seen := map[string]bool{}
	for _, e := range detail.Entries {
		seen[e.Path] = true
	}
	if !seen["docs"] || !seen["top.txt"] {
		t.Fatalf("root browse missing docs/top.txt: %v", detail.Entries)
	}
	if seen["docs/readme.md"] {
		t.Fatalf("root browse must not include nested files: %v", detail.Entries)
	}

	// Tree navigation into docs/.
	res = a.detail(t, id, map[string]string{"parent": "docs"})
	if res.status != 200 {
		t.Fatalf("docs browse status %d: %s", res.status, res.body)
	}
	if err := json.Unmarshal(res.body, &detail); err != nil {
		t.Fatal(err)
	}
	seen = map[string]bool{}
	for _, e := range detail.Entries {
		seen[e.Path] = true
	}
	if !seen["docs/readme.md"] || !seen["docs/guide"] {
		t.Fatalf("docs/ browse missing children: %v", detail.Entries)
	}

	// Case-insensitive substring search across all paths.
	res = a.detail(t, id, map[string]string{"q": "INTRO"})
	if res.status != 200 {
		t.Fatalf("search status %d: %s", res.status, res.body)
	}
	if err := json.Unmarshal(res.body, &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.Entries) != 1 || detail.Entries[0].Path != "docs/guide/intro.txt" {
		t.Fatalf("search results: %v", detail.Entries)
	}
	if detail.Query != "INTRO" {
		t.Fatalf("query echo = %q", detail.Query)
	}

	// List archives.
	res = do(t, a.srv, "GET", "/api/archives", "", origin, a.cookie)
	if res.status != 200 {
		t.Fatalf("list status %d: %s", res.status, res.body)
	}
	var list struct {
		Archives []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"archives"`
	}
	if err := json.Unmarshal(res.body, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Archives) != 1 || list.Archives[0].ID != id {
		t.Fatalf("list = %v", list.Archives)
	}
}

func TestArchiveRejectsBadFormat(t *testing.T) {
	a := newArchiveEnv(t)

	// gzip magic uploaded with a .zip name: extension/magic mismatch.
	gzipBody := []byte{0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00}
	res := a.upload(t, "fake.zip", gzipBody, "")
	assertErrorCode(t, res, 400, "invalid_archive_format")

	// .tar.gz extension outright.
	res = a.upload(t, "archive.tar.gz", gzipBody, "")
	assertErrorCode(t, res, 400, "invalid_archive_format")

	// Valid zip magic but wrong extension.
	res = a.upload(t, "archive.bin", makeZip(t, map[string]string{"a.txt": "a"}), "")
	assertErrorCode(t, res, 400, "invalid_archive_format")

	// Truncated zip header.
	res = a.upload(t, "short.zip", []byte{0x50, 0x4b}, "")
	assertErrorCode(t, res, 400, "invalid_archive_format")
}

func assertErrorCode(t *testing.T, res apiResp, status int, code string) {
	t.Helper()
	if res.status != status {
		t.Fatalf("status %d, want %d: %s", res.status, status, res.body)
	}
	var m struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(res.body, &m); err != nil {
		t.Fatalf("body %s: %v", res.body, err)
	}
	if m.Error.Code != code {
		t.Fatalf("code = %q, want %q", m.Error.Code, code)
	}
}

// encryptedZipBytes loads the prebuilt ZipCrypto fixture if 7z/7zz is
// available to exercise it; otherwise the encrypted-flow test skips.
func encryptedZipBytes(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "encrypted.zip"))
	if err != nil {
		t.Skipf("encrypted fixture missing: %v", err)
	}
	return b
}

func TestArchiveEncryptedFlow(t *testing.T) {
	a := newArchiveEnv(t)
	data := encryptedZipBytes(t)

	// Upload without password -> 201 password_required.
	res := a.upload(t, "secret.zip", data, "")
	if res.status != 201 {
		t.Fatalf("upload status %d: %s", res.status, res.body)
	}
	var created struct {
		Archive struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"archive"`
		PasswordRequired bool `json:"passwordRequired"`
	}
	if err := json.Unmarshal(res.body, &created); err != nil {
		t.Fatal(err)
	}
	if !created.PasswordRequired || created.Archive.Status != "password_required" {
		t.Fatalf("expected password_required: %+v", created)
	}
	id := created.Archive.ID

	// Wrong password unlock -> 422.
	res = do(t, a.srv, "POST", "/api/archives/"+id+"/unlock", `{"password":"wrong"}`, origin, a.cookie)
	assertErrorCode(t, res, 422, "invalid_archive_password")

	// Valid password unlock -> 200 indexed.
	res = do(t, a.srv, "POST", "/api/archives/"+id+"/unlock", `{"password":"hunter2"}`, origin, a.cookie)
	if res.status != 200 {
		t.Fatalf("unlock status %d: %s", res.status, res.body)
	}
	var unlocked struct {
		Archive struct {
			Status string `json:"status"`
		} `json:"archive"`
	}
	if err := json.Unmarshal(res.body, &unlocked); err != nil {
		t.Fatal(err)
	}
	if unlocked.Archive.Status != "indexed" {
		t.Fatalf("status = %q", unlocked.Archive.Status)
	}
}

func TestArchiveDeleteByOwner(t *testing.T) {
	a := newArchiveEnv(t)
	content := makeZip(t, map[string]string{"a.txt": "a"})
	res := a.upload(t, "del.zip", content, "")
	if res.status != 201 {
		t.Fatalf("upload status %d: %s", res.status, res.body)
	}
	var created struct {
		Archive struct {
			ID     string `json:"id"`
			SHA256 string `json:"sha256"`
		} `json:"archive"`
	}
	if err := json.Unmarshal(res.body, &created); err != nil {
		t.Fatal(err)
	}
	id := created.Archive.ID

	// Storage file exists before delete.
	storagePath := filepath.Join(os.Getenv("ARCHIVE_STORAGE_DIR"), created.Archive.SHA256+".zip")
	if _, err := os.Stat(storagePath); err != nil {
		t.Fatalf("storage file missing before delete: %v", err)
	}

	res = do(t, a.srv, "DELETE", "/api/archives/"+id, "", origin, a.cookie)
	if res.status != 204 {
		t.Fatalf("delete status %d: %s", res.status, res.body)
	}
	res = do(t, a.srv, "GET", "/api/archives/"+id, "", origin, a.cookie)
	if res.status != 404 {
		t.Fatalf("get after delete status %d", res.status)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(storagePath); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("storage file still present after delete")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestArchiveRequiresSession(t *testing.T) {
	a := newArchiveEnv(t)
	res := do(t, a.srv, "GET", "/api/archives", "", origin, "")
	if res.status != 401 {
		t.Fatalf("unauthenticated list status %d", res.status)
	}
}

func TestCredentialSearchByURL(t *testing.T) {
	a := newArchiveEnv(t)
	content := makeZip(t, map[string]string{
		"Browser/Chrome/passwords.txt": "https://auth.openai.com/log\tvictim1@mail.com\tPass123!\n" +
			".auth.openai.com\tvictim2@mail.com\tS3cret\n" +
			"instagram.com\tjohn_doe\thunter2\n",
		"Cookies/Default/Cookies.txt": ".google.com\tTRUE\t/\tTRUE\t1822690705\tSSID\tx\n",
	})

	res := a.upload(t, "creds.zip", content, "")
	if res.status != 201 {
		t.Fatalf("upload status %d: %s", res.status, res.body)
	}

	// URL substring search matches both the full URL and the dot-prefixed
	// domain column.
	r := do(t, a.srv, "GET", "/api/passwords?q=auth.openai.com", "", origin, a.cookie)
	if r.status != 200 {
		t.Fatalf("password search status %d: %s", r.status, r.body)
	}
	var got struct {
		Results []struct {
			URL       string `json:"url"`
			Domain    string `json:"domain"`
			Login     string `json:"login"`
			Password  string `json:"password"`
			EntryPath string `json:"entryPath"`
		} `json:"results"`
		TotalCount int64 `json:"totalCount"`
		HasMore    bool  `json:"hasMore"`
	}
	if err := json.Unmarshal(r.body, &got); err != nil {
		t.Fatalf("%s: %v", r.body, err)
	}
	if got.TotalCount != 2 || len(got.Results) != 2 {
		t.Fatalf("expected 2 openai.com credentials, got %d (%s)", got.TotalCount, r.body)
	}
	logins := map[string]bool{}
	for _, c := range got.Results {
		logins[c.Login] = true
		if c.Domain != "openai.com" {
			t.Errorf("domain = %q, want openai.com", c.Domain)
		}
		if c.EntryPath != "Browser/Chrome/passwords.txt" {
			t.Errorf("entryPath = %q", c.EntryPath)
		}
	}
	if !logins["victim1@mail.com"] || !logins["victim2@mail.com"] {
		t.Errorf("missing logins: %+v", got.Results)
	}

	// Unrelated domain search returns nothing.
	r2 := do(t, a.srv, "GET", "/api/passwords?q=github.com", "", origin, a.cookie)
	var none struct {
		TotalCount int64 `json:"totalCount"`
	}
	if err := json.Unmarshal(r2.body, &none); err != nil {
		t.Fatal(err)
	}
	if none.TotalCount != 0 {
		t.Fatalf("expected 0 github.com credentials, got %d", none.TotalCount)
	}

	// Pagination: newest row first (id DESC).
	r3 := do(t, a.srv, "GET", "/api/passwords?q=openai&limit=1&offset=0", "", origin, a.cookie)
	var page struct {
		Results []struct {
			Login string `json:"login"`
		} `json:"results"`
		TotalCount int64 `json:"totalCount"`
		HasMore    bool  `json:"hasMore"`
	}
	if err := json.Unmarshal(r3.body, &page); err != nil {
		t.Fatal(err)
	}
	if page.TotalCount != 2 || len(page.Results) != 1 || !page.HasMore ||
		page.Results[0].Login != "victim2@mail.com" {
		t.Fatalf("page = %+v (%s)", page, r3.body)
	}
	r4 := do(t, a.srv, "GET", "/api/passwords?q=openai&limit=1&offset=1", "", origin, a.cookie)
	var last struct {
		Results []struct {
			Login string `json:"login"`
		} `json:"results"`
		HasMore bool `json:"hasMore"`
	}
	if err := json.Unmarshal(r4.body, &last); err != nil {
		t.Fatal(err)
	}
	if len(last.Results) != 1 || last.HasMore || last.Results[0].Login != "victim1@mail.com" {
		t.Fatalf("last page = %+v (%s)", last, r4.body)
	}
}

func TestCredentialSearchByEmailDomain(t *testing.T) {
	a := newArchiveEnv(t)
	// Deterministic tabbed password file order.
	// Format: URL \t LOGIN \t PASSWORD
	content := makeZip(t, map[string]string{
		"Browser/Chrome/passwords.txt": "" +
			// 1-3: Target records for @mail.com search (mixed case, plus tag, unrelated URLs)
			"https://alpha.example.org/login\tfirst@mail.com\tPass1\n" +
			"https://beta.example.com/signin\tsecond+tag@MAIL.COM\tPass2\n" +
			"https://gamma.corp.net/auth\tThird@Mail.Com\tPass3\n" +
			// 4: Subdomain lookalike (must NOT match @mail.com; must match @sub.mail.com)
			"https://delta.io/session\tsubuser@sub.mail.com\tPass4\n" +
			// 5-6: Suffix lookalikes (must NOT match @mail.com)
			"https://epsilon.org/app\tfakeuser@mail.com.fake\tPass5\n" +
			"https://zeta.com/portal\tnotuser@notmail.com\tPass6\n" +
			// 7: URL-only @ match (must NOT match @mail.com; bare mail.com stays URL mode)
			"https://mail.com/login?ref=@mail.com\turlonly_user\tPass7\n" +
			// 8: Password-only match (must NOT match @mail.com)
			"https://eta.net/login\tpwonly_user@other.org\tsecret@mail.com\n" +
			// 9-10: Wildcard % literal test
			"https://theta.org/login\tpct@wild%card.org\tPass9\n" +
			"https://iota.com/login\tpct@wildXcard.org\tPass10\n" +
			// 11-12: Wildcard _ literal test
			"https://kappa.org/login\tund@under_score.net\tPass11\n" +
			"https://lambda.net/login\tund@underXscore.net\tPass12\n" +
			// 13-14: Backslash \ literal test
			"https://mu.org/login\tslash@esc\\domain.io\tPass13\n" +
			"https://nu.com/login\tslash@escXdomain.io\tPass14\n",
	})

	res := a.upload(t, "email_creds.zip", content, "")
	if res.status != 201 {
		t.Fatalf("upload status %d: %s", res.status, res.body)
	}

	type credItem struct {
		ID              int64  `json:"id"`
		ArchiveID       string `json:"archiveId"`
		ArchiveFilename string `json:"archiveFilename"`
		EntryPath       string `json:"entryPath"`
		EntryName       string `json:"entryName"`
		URL             string `json:"url"`
		Domain          string `json:"domain"`
		Login           string `json:"login"`
		Password        string `json:"password"`
	}

	type credResponse struct {
		Results    []credItem `json:"results"`
		TotalCount int64      `json:"totalCount"`
		Limit      int        `json:"limit"`
		Offset     int        `json:"offset"`
		HasMore    bool       `json:"hasMore"`
	}

	search := func(query string, limit, offset int) credResponse {
		t.Helper()
		path := fmt.Sprintf("/api/passwords?q=%s&limit=%d&offset=%d", url.QueryEscape(query), limit, offset)
		r := do(t, a.srv, "GET", path, "", origin, a.cookie)
		if r.status != 200 {
			t.Fatalf("search %q status %d: %s", query, r.status, r.body)
		}
		var resp credResponse
		if err := json.Unmarshal(r.body, &resp); err != nil {
			t.Fatalf("unmarshal search %q response: %v (%s)", query, err, r.body)
		}
		return resp
	}

	// 1. Exact @mail.com excludes subdomain/suffix lookalikes, URL-only @ match, password-only match.
	// Returns newest first (descending ID): Third@Mail.Com (3), second+tag@MAIL.COM (2), first@mail.com (1).
	allMail := search("@mail.com", 100, 0)
	if allMail.TotalCount != 3 || len(allMail.Results) != 3 {
		t.Fatalf("expected 3 @mail.com credentials, got totalCount=%d len=%d", allMail.TotalCount, len(allMail.Results))
	}
	if allMail.Results[0].Login != "Third@Mail.Com" ||
		allMail.Results[1].Login != "second+tag@MAIL.COM" ||
		allMail.Results[2].Login != "first@mail.com" {
		t.Fatalf("unexpected @mail.com results order: %+v", allMail.Results)
	}
	if allMail.HasMore {
		t.Errorf("expected hasMore=false for full page, got true")
	}
	if allMail.Results[2].ArchiveFilename != "email_creds.zip" ||
		allMail.Results[2].EntryPath != "Browser/Chrome/passwords.txt" ||
		allMail.Results[2].Domain != "example.org" ||
		allMail.Results[2].URL != "https://alpha.example.org/login" ||
		allMail.Results[2].Password != "Pass1" {
		t.Fatalf("first@mail.com identity fields mismatch: %+v", allMail.Results[2])
	}

	// 2. Filtered count and paginated newest order / hasMore.
	page1 := search("@mail.com", 2, 0)
	if page1.TotalCount != 3 || len(page1.Results) != 2 || !page1.HasMore {
		t.Fatalf("page 1 mismatch: totalCount=%d len=%d hasMore=%v", page1.TotalCount, len(page1.Results), page1.HasMore)
	}
	if page1.Results[0].Login != "Third@Mail.Com" || page1.Results[1].Login != "second+tag@MAIL.COM" {
		t.Fatalf("page 1 items mismatch: %+v", page1.Results)
	}

	page2 := search("@mail.com", 2, 2)
	if page2.TotalCount != 3 || len(page2.Results) != 1 || page2.HasMore {
		t.Fatalf("page 2 mismatch: totalCount=%d len=%d hasMore=%v", page2.TotalCount, len(page2.Results), page2.HasMore)
	}
	if page2.Results[0].Login != "first@mail.com" {
		t.Fatalf("page 2 item mismatch: %+v", page2.Results)
	}

	// 3. @sub.mail.com exact.
	subResp := search("@sub.mail.com", 100, 0)
	if subResp.TotalCount != 1 || len(subResp.Results) != 1 {
		t.Fatalf("expected 1 @sub.mail.com credential, got %d", subResp.TotalCount)
	}
	if subResp.Results[0].Login != "subuser@sub.mail.com" {
		t.Fatalf("expected subuser@sub.mail.com, got %q", subResp.Results[0].Login)
	}

	// 4. Whitespace and case insensitivity.
	for _, q := range []string{"  @mail.com  ", "@MAIL.COM", "@MaIL.CoM", "  @MAIL.COM  "} {
		caseResp := search(q, 100, 0)
		if caseResp.TotalCount != 3 || len(caseResp.Results) != 3 {
			t.Fatalf("search %q expected 3 results, got %d", q, caseResp.TotalCount)
		}
		if caseResp.Results[0].Login != "Third@Mail.Com" ||
			caseResp.Results[1].Login != "second+tag@MAIL.COM" ||
			caseResp.Results[2].Login != "first@mail.com" {
			t.Fatalf("search %q unexpected order: %+v", q, caseResp.Results)
		}
	}

	// 5. Bare @ returns none.
	for _, q := range []string{"@", "   @   "} {
		bareResp := search(q, 100, 0)
		if bareResp.TotalCount != 0 || len(bareResp.Results) != 0 || bareResp.HasMore {
			t.Fatalf("bare @ search %q expected 0 results, got totalCount=%d len=%d", q, bareResp.TotalCount, len(bareResp.Results))
		}
	}

	// 6. Bare mail.com stays URL mode: excludes @mail.com logins on unrelated URLs,
	// matches only the record whose URL/domain is mail.com.
	urlModeResp := search("mail.com", 100, 0)
	if urlModeResp.TotalCount != 1 || len(urlModeResp.Results) != 1 {
		t.Fatalf("bare mail.com expected 1 URL match, got %d (%+v)", urlModeResp.TotalCount, urlModeResp.Results)
	}
	if urlModeResp.Results[0].Login != "urlonly_user" {
		t.Fatalf("bare mail.com expected urlonly_user, got %q", urlModeResp.Results[0].Login)
	}

	// 7. Wildcard %, _, backslash literal cases.
	pctResp := search("@wild%card.org", 100, 0)
	if pctResp.TotalCount != 1 || len(pctResp.Results) != 1 {
		t.Fatalf("expected 1 @wild%%card.org credential, got %d", pctResp.TotalCount)
	}
	if pctResp.Results[0].Login != "pct@wild%card.org" {
		t.Fatalf("expected pct@wild%%card.org, got %q", pctResp.Results[0].Login)
	}

	undResp := search("@under_score.net", 100, 0)
	if undResp.TotalCount != 1 || len(undResp.Results) != 1 {
		t.Fatalf("expected 1 @under_score.net credential, got %d", undResp.TotalCount)
	}
	if undResp.Results[0].Login != "und@under_score.net" {
		t.Fatalf("expected und@under_score.net, got %q", undResp.Results[0].Login)
	}

	slashResp := search("@esc\\domain.io", 100, 0)
	if slashResp.TotalCount != 1 || len(slashResp.Results) != 1 {
		t.Fatalf("expected 1 @esc\\domain.io credential, got %d", slashResp.TotalCount)
	}
	if slashResp.Results[0].Login != "slash@esc\\domain.io" {
		t.Fatalf("expected slash@esc\\domain.io, got %q", slashResp.Results[0].Login)
	}
}
