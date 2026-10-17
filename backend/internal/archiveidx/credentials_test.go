package archiveidx

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestParseCredentialFileBytes_TabFormat(t *testing.T) {
	raw := []byte(
		"https://auth.openai.com/login\tuser@mail.com\tPass123!\n" +
			".auth.openai.com\tuser2@mail.com\tS3cret\n" +
			"\n" +
			"# comment line\n" +
			"url\tlogin\tpassword\n" +
			"instagram.com\tjohn_doe\thunter2\tEXTRA-COL\n")
	chunks := parseCredentialFileBytes("Browser/passwords.txt", "passwords.txt", raw)
	if len(chunks) != 3 {
		t.Fatalf("expected 3 chunks, got %d: %+v", len(chunks), chunks)
	}
	if chunks[0].Domain != "openai.com" || chunks[0].URL != "https://auth.openai.com/login" {
		t.Errorf("chunk0 = %+v", chunks[0])
	}
	if chunks[0].Login != "user@mail.com" || chunks[0].Password != "Pass123!" {
		t.Errorf("chunk0 creds = %q / %q", chunks[0].Login, chunks[0].Password)
	}
	if chunks[1].Domain != "openai.com" {
		t.Errorf("leading-dot domain: %+v", chunks[1])
	}
	if chunks[2].Domain != "instagram.com" || chunks[2].Login != "john_doe" || chunks[2].Password != "hunter2" {
		t.Errorf("chunk2 = %+v", chunks[2])
	}
	for _, c := range chunks {
		if c.EntryPath != "Browser/passwords.txt" || c.EntryName != "passwords.txt" {
			t.Errorf("source attribution wrong: %+v", c)
		}
	}
}

func TestParseCredentialFileBytes_LoginFirstVariant(t *testing.T) {
	raw := []byte("john_doe\thunter2\thttps://instagram.com/login\n")
	chunks := parseCredentialFileBytes("p.txt", "p.txt", raw)
	if len(chunks) != 1 || chunks[0].Domain != "instagram.com" ||
		chunks[0].Login != "john_doe" || chunks[0].Password != "hunter2" {
		t.Fatalf("got %+v", chunks)
	}
}

func TestParseCredentialFileBytes_TwoColumnTab(t *testing.T) {
	raw := []byte("https://github.com/login\tjohn:pw123\n")
	chunks := parseCredentialFileBytes("p.txt", "p.txt", raw)
	if len(chunks) != 1 || chunks[0].Login != "john" || chunks[0].Password != "pw123" ||
		chunks[0].Domain != "github.com" {
		t.Fatalf("got %+v", chunks)
	}
}

func TestParseCredentialFileBytes_PipeAndSemicolon(t *testing.T) {
	chunks := parseCredentialFileBytes("p.txt", "p.txt",
		[]byte("https://x.com|a|b\nhttps://y.com;c;d\n"))
	if len(chunks) != 2 {
		t.Fatalf("got %d: %+v", len(chunks), chunks)
	}
	if chunks[0].Domain != "x.com" || chunks[0].Login != "a" || chunks[0].Password != "b" {
		t.Errorf("pipe: %+v", chunks[0])
	}
	if chunks[1].Domain != "y.com" || chunks[1].Login != "c" || chunks[1].Password != "d" {
		t.Errorf("semicolon: %+v", chunks[1])
	}
}

func TestParseCredentialFileBytes_ColonOnly(t *testing.T) {
	tests := []struct {
		line      string
		wantURL   string
		wantLogin string
		wantPass  string
	}{
		{"https://site.com/login:mail@x.com:pass", "https://site.com/login", "mail@x.com", "pass"},
		{"https://site.com:443/login:mail:pass", "https://site.com:443/login", "mail", "pass"},
		{"https://site.com:mail@x.com:pass", "https://site.com", "mail@x.com", "pass"},
		{"site.com:login:pass", "site.com", "login", "pass"},
		{"site.com:8080:login:pass", "site.com", "login", "pass"},
		{"https://site.com/login?redirect=https://site.com/home:mail@x.com:pass", "https://site.com/login?redirect=https://site.com/home", "mail@x.com", "pass"},
		{"http://192.168.1.1/admin:admin:secret", "http://192.168.1.1/admin", "admin", "secret"},
		{"192.168.1.1:admin:secret", "192.168.1.1", "admin", "secret"},
	}
	for _, tt := range tests {
		chunks := parseCredentialFileBytes("passwords.txt", "passwords.txt", []byte(tt.line+"\n"))
		if len(chunks) != 1 {
			t.Errorf("%q: expected 1 chunk, got %d", tt.line, len(chunks))
			continue
		}
		c := chunks[0]
		if c.URL != tt.wantURL || c.Login != tt.wantLogin || c.Password != tt.wantPass {
			t.Errorf("%q: got url=%q login=%q pass=%q", tt.line, c.URL, c.Login, c.Password)
		}
	}
}

func TestParseCredentialFileBytes_PerDomainFile(t *testing.T) {
	// "Passwords/instagram.com.txt" with bare login:pass lines
	chunks := parseCredentialFileBytes("Passwords/instagram.com.txt", "instagram.com.txt",
		[]byte("john_doe:hunter2\njane:hunter3\n"))
	if len(chunks) != 2 {
		t.Fatalf("got %d", len(chunks))
	}
	if chunks[0].Domain != "instagram.com" || chunks[0].URL != "instagram.com" ||
		chunks[0].Login != "john_doe" || chunks[0].Password != "hunter2" {
		t.Errorf("chunk0 = %+v", chunks[0])
	}
}

func TestParseCredentialFileBytes_Sanitization(t *testing.T) {
	// Windows-1251 garbage, null bytes, invalid UTF-8 must not panic and must
	// produce sanitized rows.
	raw := append([]byte("https://vk.com/login\tuser\x00\xbe\tpass\xff\n"),
		[]byte("https://ok.ru\tuser2\tpass2\n")...)
	chunks := parseCredentialFileBytes("p.txt", "p.txt", raw)
	if len(chunks) != 2 {
		t.Fatalf("got %d: %+v", len(chunks), chunks)
	}
	for _, c := range chunks {
		if bytes.Contains([]byte(c.Login), []byte{0}) || bytes.Contains([]byte(c.Password), []byte{0}) {
			t.Errorf("null byte survived: %+v", c)
		}
	}
}

func TestParseCredentialFileBytes_RejectsGarbage(t *testing.T) {
	cases := [][]byte{
		nil,
		[]byte("   \n \n"),
		[]byte("just a random sentence without separators\n"),
		[]byte("no-url-login:pass\n"), // login:pass without per-domain file
		[]byte("https://site.com:443\n"),
		[]byte("user@mail.com:pass\n"), // email login without any URL
	}
	for i, raw := range cases {
		if chunks := parseCredentialFileBytes("p.txt", "p.txt", raw); len(chunks) != 0 {
			t.Errorf("case %d: expected 0 chunks, got %d: %+v", i, len(chunks), chunks)
		}
	}
}

func TestIsCandidatePasswordFile(t *testing.T) {
	yes := [][2]string{
		{"Browser/passwords.txt", "passwords.txt"},
		{"Browser/Password.txt", "Password.txt"},
		{"Passwords/instagram.com.txt", "instagram.com.txt"},
		{"log/credentials.csv", "credentials.csv"},
		{"soft/passwd.log", "passwd.log"},
		{"passwords", ""}, // extensionless dir-ish name
	}
	for _, c := range yes {
		if !isCandidatePasswordFile(c[0], c[1], 1024) {
			t.Errorf("expected candidate: %q / %q", c[0], c[1])
		}
	}
	no := [][2]string{
		{"Cookies/Default/Cookies.txt", "Cookies.txt"},
		{"Browser/Login Data", "Login Data"},
		{"Browser/autofill.txt", "autofill.txt"},
		{"app/MyPasswords.sqlite", "MyPasswords.sqlite"},
		{"docs/passwords.pdf", "passwords.pdf"},
		{"img/password.png", "password.png"},
		{"Tools/7z-password.exe", "7z-password.exe"},
		{"history.txt", "history.txt"},
		{"Cookies.txt", "Cookies.txt"},
	}
	for _, c := range no {
		if isCandidatePasswordFile(c[0], c[1], 1024) {
			t.Errorf("expected non-candidate: %q / %q", c[0], c[1])
		}
	}
	if isCandidatePasswordFile("a/passwords.txt", "passwords.txt", 0) {
		t.Error("empty file must not be a candidate")
	}
	if isCandidatePasswordFile("a/passwords.txt", "passwords.txt", 20*1024*1024) {
		t.Error("oversize file must not be a candidate")
	}
}

func TestHasCredentialSignatures(t *testing.T) {
	if hasCredentialSignatures([]byte("url\tlogin\tpass\n")) != true {
		t.Error("tab line should pass")
	}
	if hasCredentialSignatures([]byte("login:pass\n")) != true {
		t.Error("colon line should pass")
	}
	if hasCredentialSignatures([]byte("no separator line here\n")) {
		t.Error("plain text without separators should fail")
	}
	if hasCredentialSignatures([]byte("SQLite format 3\x00xxxx")) {
		t.Error("sqlite must fail")
	}
	if hasCredentialSignatures([]byte(`[{"domain":"x.com"}]`)) {
		t.Error("json must fail")
	}
	if hasCredentialSignatures(bytes.Repeat([]byte{0}, 32)) {
		t.Error("binary must fail")
	}
	if hasCredentialSignatures([]byte("short")) {
		t.Error("too short must fail")
	}
}

func TestExtractCredentials_ZipFastPath(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	type fdef struct {
		name string
		body string
	}
	files := []fdef{
		{"Browser/Chrome/passwords.txt", "https://auth.openai.com/log\tvictim@mail.com\tPass123\n"},
		{"Cookies/Default/Cookies.txt", ".google.com\tTRUE\t/\tTRUE\t1822690705\tSSID\tx\n"},
		{"readme.txt", "This archive contains stealer logs.\n"},
	}
	for _, fd := range files {
		w, err := zw.Create(fd.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(fd.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zipPath := filepath.Join(t.TempDir(), "log.zip")
	if err := os.WriteFile(zipPath, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	// Entries as produced by IndexFile.
	var entries []Entry
	for _, fd := range files {
		entries = append(entries, Entry{
			Path: normalizePath(fd.name), Name: filepath.Base(fd.name),
			ParentPath: parentOf(normalizePath(fd.name)), SizeBytes: int64(len(fd.body)),
		})
	}

	chunks := ExtractCredentials(t.Context(), zipPath, "zip", "", entries)
	if len(chunks) != 1 {
		t.Fatalf("expected exactly 1 credential chunk, got %d: %+v", len(chunks), chunks)
	}
	c := chunks[0]
	if c.Domain != "openai.com" || c.Login != "victim@mail.com" || c.Password != "Pass123" {
		t.Errorf("chunk = %+v", c)
	}
	if c.EntryPath != "Browser/Chrome/passwords.txt" {
		t.Errorf("entry path = %q", c.EntryPath)
	}
}

func TestNormalizePath_ZipSlipProtection(t *testing.T) {
	if got := normalizePath("../../etc/passwd"); got != "etc/passwd" {
		t.Fatalf("normalizePath(../../etc/passwd) = %q, want etc/passwd", got)
	}
	if got := normalizePath("..\\..\\Windows\\win.ini"); got != "Windows/win.ini" {
		t.Fatalf("normalizePath(..\\\\..\\\\Windows\\\\win.ini) = %q, want Windows/win.ini", got)
	}
	if got := normalizePath("."); got != "" {
		t.Fatalf("normalizePath(.) = %q, want empty", got)
	}
	if got := normalizePath("/"); got != "" {
		t.Fatalf("normalizePath(/) = %q, want empty", got)
	}
}
