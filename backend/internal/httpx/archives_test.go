package httpx_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
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
