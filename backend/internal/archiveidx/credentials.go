package archiveidx

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/nwaples/rardecode/v2"
)

// CredentialChunk is one parsed user:pass credential line attributed to a URL.
type CredentialChunk struct {
	EntryPath string
	EntryName string
	URL       string
	Domain    string
	Login     string
	Password  string
}

// ExtractCredentials batch-extracts every stealer-log password file from an
// archive, parses url/login/password lines, and returns one chunk per
// credential line. Temporary extraction folders are always deleted before
// returning.
func ExtractCredentials(
	ctx context.Context,
	filePath, format, password string,
	entries []Entry,
) []CredentialChunk {
	var candidates []Entry
	for _, e := range entries {
		if !e.IsDir && e.SizeBytes > 0 && e.SizeBytes <= 15*1024*1024 && isCandidatePasswordFile(e.Path, e.Name, e.SizeBytes) {
			candidates = append(candidates, e)
		}
	}
	if len(candidates) == 0 {
		return nil
	}

	cleanPw := strings.Trim(strings.TrimSpace(password), "`'\"")
	// Ultra-fast path: stream candidate password files straight from the zip
	// central directory in memory with no temporary disk files.
	if format == "zip" && cleanPw == "" {
		if chunks, ok := extractZipCandidateCredentials(filePath, candidates); ok {
			return chunks
		}
	}

	tmpDir, err := os.MkdirTemp("", "cred-idx-*")
	if err != nil {
		return nil
	}
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	bin, ok := sevenZBin()
	effectivePath := ResolvePrimaryArchiveVolume(filePath)
	pathsToTry := []string{filePath}
	if effectivePath != filePath {
		pathsToTry = append(pathsToTry, effectivePath)
	}
	passwordsToTry := candidatePasswords(password)

	if ok {
		var relPaths []string
		for _, c := range candidates {
			if np := normalizePath(c.Path); np != "" {
				relPaths = append(relPaths, np)
			}
		}
		if len(relPaths) == 0 {
			return nil
		}
		listFilePath := filepath.Join(tmpDir, "listfile.txt")
		if err := os.WriteFile(listFilePath, []byte(strings.Join(relPaths, "\n")+"\n"), 0o600); err == nil {
			for _, p := range pathsToTry {
				for _, pw := range passwordsToTry {
					args := []string{
						"x", "-y", "-spd", "-bso0", "-bse0", "-mmt=on",
						"-p" + pw,
						"-o" + tmpDir,
						"@" + listFilePath,
						"--", p,
					}
					_, _ = run7z(ctx, bin, args)
					if dirHasExtractedFiles(tmpDir, "listfile.txt") {
						break
					}
				}
				if dirHasExtractedFiles(tmpDir, "listfile.txt") {
					break
				}
			}
			_ = os.Remove(listFilePath)
		}

		if !dirHasExtractedFiles(tmpDir, "") {
			for _, p := range pathsToTry {
				for _, pw := range passwordsToTry {
					wildcardArgs := []string{
						"x", "-y", "-spd", "-bso0", "-bse0", "-mmt=on",
						"-p" + pw,
						"-o" + tmpDir,
						"-ir!*password*", "-ir!*passwd*", "-ir!*credential*", "-ir!*creds*",
						"-xr!*.exe", "-xr!*.dll", "-xr!*.png", "-xr!*.jpg", "-xr!*.jpeg", "-xr!*.gif",
						"-xr!*.zip", "-xr!*.rar", "-xr!*.7z", "-xr!*.sqlite*", "-xr!*.db", "-xr!*.pdf",
						"--", p,
					}
					_, _ = run7z(ctx, bin, wildcardArgs)
					if dirHasExtractedFiles(tmpDir, "") {
						break
					}
				}
				if dirHasExtractedFiles(tmpDir, "") {
					break
				}
			}
		}
	}

	if !dirHasExtractedFiles(tmpDir, "") {
		if format == "zip" {
			extractZipCredentialsToDir(filePath, tmpDir)
			if !dirHasExtractedFiles(tmpDir, "") && effectivePath != filePath {
				extractZipCredentialsToDir(effectivePath, tmpDir)
			}
		} else if format == "rar" {
			for _, p := range pathsToTry {
				for _, pw := range passwordsToTry {
					extractRarCredentialsToDir(p, pw, tmpDir)
					if dirHasExtractedFiles(tmpDir, "") {
						break
					}
				}
				if dirHasExtractedFiles(tmpDir, "") {
					break
				}
			}
		}
	}

	type diskCredJob struct {
		fullPath  string
		entryPath string
		entryName string
	}
	var diskJobs []diskCredJob
	_ = filepath.WalkDir(tmpDir, func(fullPath string, d os.DirEntry, err error) error {
		if err != nil || d == nil || d.IsDir() {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil || info.Size() <= 0 || info.Size() > 15*1024*1024 {
			return nil
		}
		rel, rerr := filepath.Rel(tmpDir, fullPath)
		if rerr != nil {
			return nil
		}
		entryPath := normalizePath(filepath.ToSlash(rel))
		entryName := filepath.Base(entryPath)
		if !isCandidatePasswordFile(entryPath, entryName, info.Size()) {
			return nil
		}
		diskJobs = append(diskJobs, diskCredJob{
			fullPath:  fullPath,
			entryPath: entryPath,
			entryName: entryName,
		})
		return nil
	})
	if len(diskJobs) == 0 {
		return nil
	}

	numWorkers := runtime.NumCPU() * 2
	if numWorkers < 4 {
		numWorkers = 4
	}
	if numWorkers > len(diskJobs) {
		numWorkers = len(diskJobs)
	}

	jobsCh := make(chan diskCredJob, len(diskJobs))
	for _, j := range diskJobs {
		jobsCh <- j
	}
	close(jobsCh)

	var wg sync.WaitGroup
	resultsCh := make(chan []CredentialChunk, numWorkers)
	for range numWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var local []CredentialChunk
			for job := range jobsCh {
				raw, rerr := os.ReadFile(job.fullPath)
				if rerr != nil || len(raw) == 0 || !hasCredentialSignatures(raw) {
					continue
				}
				chunks := parseCredentialFileBytes(job.entryPath, job.entryName, raw)
				if len(chunks) > 0 {
					local = append(local, chunks...)
				}
			}
			if len(local) > 0 {
				resultsCh <- local
			}
		}()
	}
	wg.Wait()
	close(resultsCh)

	var result []CredentialChunk
	for chunkList := range resultsCh {
		result = append(result, chunkList...)
	}
	return result
}

// isCandidatePasswordFile reports whether an archive entry is likely a
// stealer-log password file (passwords.txt, Password.txt, per-domain files
// inside a Passwords/ folder, etc.).
func isCandidatePasswordFile(entryPath, entryName string, size int64) bool {
	if size <= 0 || size > 15*1024*1024 {
		return false
	}
	ln := strings.ToLower(entryName)
	if strings.HasPrefix(ln, "._") {
		return false
	}

	// Skip binary / media / archive / database files outright.
	for _, ext := range []string{
		".exe", ".dll", ".png", ".jpg", ".jpeg", ".gif", ".zip", ".rar",
		".7z", ".tar", ".gz", ".sqlite", ".sqlite3", ".db", ".pdf",
		".mp4", ".mp3", ".jar",
	} {
		if strings.HasSuffix(ln, ext) {
			return false
		}
	}

	// Match by file name OR by a Password(s)/Credential(s) parent folder
	// (some families store one per-domain file inside such folders).
	needle := strings.Contains(ln, "password") ||
		strings.Contains(ln, "passwd") ||
		strings.Contains(ln, "credential") ||
		strings.Contains(ln, "creds")
	lp := "/" + strings.ToLower(entryPath)
	if !needle && !strings.Contains(lp, "/password") &&
		!strings.Contains(lp, "/passwd") &&
		!strings.Contains(lp, "/credential") &&
		!strings.Contains(lp, "/creds") {
		return false
	}

	// Only plain-text shapes: .txt, .log, .csv, or extensionless files.
	if strings.HasSuffix(ln, ".txt") || strings.HasSuffix(ln, ".log") ||
		strings.HasSuffix(ln, ".csv") {
		return true
	}
	return !strings.Contains(ln, ".")
}

// hasCredentialSignatures is a cheap pre-check that rejects binary blobs and
// non-credential text before the full parser runs.
func hasCredentialSignatures(raw []byte) bool {
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")) // Strip UTF-8 BOM
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) < 8 {
		return false
	}
	// SQLite databases (Login Data / Web Data) are not text credential files.
	if bytes.HasPrefix(trimmed, []byte("SQLite format 3\x00")) {
		return false
	}
	// JSON blobs are cookie stores / manifests, not url\tlogin\tpass logs.
	if trimmed[0] == '{' || trimmed[0] == '[' {
		return false
	}
	// Null bytes anywhere in the head indicate a binary file.
	head := trimmed
	if len(head) > 4096 {
		head = head[:4096]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return false
	}
	// A credential line needs some separator character.
	return bytes.ContainsAny(head, "\t:;|")
}

func extractZipCredentialsToDir(filePath, tmpDir string) {
	zr, err := zip.OpenReader(filePath)
	if err != nil {
		return
	}
	defer zr.Close()
	cleanTmp := filepath.Clean(tmpDir) + string(filepath.Separator)
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		np := normalizePath(f.Name)
		if np == "" || !isCandidatePasswordFile(np, filepath.Base(np), int64(f.UncompressedSize64)) {
			continue
		}
		dest := filepath.Join(tmpDir, filepath.FromSlash(np))
		cleanDest := filepath.Clean(dest)
		if !strings.HasPrefix(cleanDest, cleanTmp) {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		_ = os.MkdirAll(filepath.Dir(cleanDest), 0o755)
		out, err := os.Create(cleanDest)
		if err == nil {
			_, _ = io.Copy(out, io.LimitReader(rc, 15*1024*1024))
			_ = out.Close()
		}
		_ = rc.Close()
	}
}

func extractRarCredentialsToDir(filePath, password, tmpDir string) {
	var opts []rardecode.Option
	if password != "" {
		opts = append(opts, rardecode.Password(password))
	}
	rc, err := rardecode.OpenReader(filePath, opts...)
	if err != nil {
		return
	}
	defer rc.Close()
	cleanTmp := filepath.Clean(tmpDir) + string(filepath.Separator)
	for {
		hdr, err := rc.Next()
		if err != nil {
			break
		}
		if hdr.IsDir {
			continue
		}
		np := normalizePath(hdr.Name)
		if np == "" || !isCandidatePasswordFile(np, filepath.Base(np), hdr.UnPackedSize) {
			continue
		}
		dest := filepath.Join(tmpDir, filepath.FromSlash(np))
		cleanDest := filepath.Clean(dest)
		if !strings.HasPrefix(cleanDest, cleanTmp) {
			continue
		}
		_ = os.MkdirAll(filepath.Dir(cleanDest), 0o755)
		out, err := os.Create(cleanDest)
		if err == nil {
			_, _ = io.Copy(out, io.LimitReader(rc, 15*1024*1024))
			_ = out.Close()
		}
	}
}

func extractZipCandidateCredentials(filePath string, candidates []Entry) ([]CredentialChunk, bool) {
	zr, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, false
	}
	defer zr.Close()

	candMap := make(map[string]bool, len(candidates))
	for _, c := range candidates {
		candMap[normalizePath(c.Path)] = true
	}
	useFilter := len(candidates) > 0

	type fileJob struct {
		f    *zip.File
		np   string
		base string
	}

	var matchedJobs []fileJob
	for _, f := range zr.File {
		if f.Flags&0x1 != 0 {
			return nil, false
		}
		if f.FileInfo().IsDir() {
			continue
		}
		np := normalizePath(f.Name)
		if np == "" || f.UncompressedSize64 == 0 || f.UncompressedSize64 > 15*1024*1024 {
			continue
		}
		base := filepath.Base(np)
		if useFilter && !candMap[np] {
			if !isCandidatePasswordFile(np, base, int64(f.UncompressedSize64)) {
				continue
			}
		} else if !useFilter && !isCandidatePasswordFile(np, base, int64(f.UncompressedSize64)) {
			continue
		}
		matchedJobs = append(matchedJobs, fileJob{f: f, np: np, base: base})
	}

	if len(matchedJobs) == 0 {
		return nil, true
	}

	numWorkers := runtime.NumCPU() * 2
	if numWorkers < 4 {
		numWorkers = 4
	}
	if numWorkers > len(matchedJobs) {
		numWorkers = len(matchedJobs)
	}

	jobsCh := make(chan fileJob, len(matchedJobs))
	for _, j := range matchedJobs {
		jobsCh <- j
	}
	close(jobsCh)

	var wg sync.WaitGroup
	resultsCh := make(chan []CredentialChunk, numWorkers)
	var openFailed atomic.Bool

	for range numWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var localChunks []CredentialChunk
			for job := range jobsCh {
				rc, err := job.f.Open()
				if err != nil {
					openFailed.Store(true)
					continue
				}
				raw, rerr := io.ReadAll(io.LimitReader(rc, 15*1024*1024))
				_ = rc.Close()
				if rerr != nil || len(raw) == 0 || !hasCredentialSignatures(raw) {
					continue
				}
				chunks := parseCredentialFileBytes(job.np, job.base, raw)
				if len(chunks) > 0 {
					localChunks = append(localChunks, chunks...)
				}
			}
			if len(localChunks) > 0 {
				resultsCh <- localChunks
			}
		}()
	}

	wg.Wait()
	close(resultsCh)

	var totalChunks []CredentialChunk
	for chunkList := range resultsCh {
		totalChunks = append(totalChunks, chunkList...)
	}
	if openFailed.Load() && len(totalChunks) == 0 {
		return nil, false
	}
	return totalChunks, true
}

// cleanCredentialField strips NUL bytes, BOMs, invisible characters, and
// surrounding quotes/brackets from one parsed field.
func cleanCredentialField(s string) string {
	if strings.IndexByte(s, 0) >= 0 {
		s = strings.ReplaceAll(s, "\x00", "")
	}
	return strings.Trim(s, "\ufeff\u200b\u200c\u200d\u200e\u200f \t\r\n\"'`[],")
}

// looksLikeURL reports whether s is plausibly a URL or host (not a bare
// login). "auth.openai.com" and "https://..." qualify; "user@mail.com" and
// "JohnDoe" do not.
func looksLikeURL(s string) bool {
	if s == "" {
		return false
	}
	low := strings.ToLower(s)
	if strings.Contains(low, "://") {
		return true
	}
	if strings.Contains(s, "@") {
		return false // emails / user@host are logins, never URLs
	}
	if strings.ContainsAny(s, " \t") {
		return false
	}
	if ip := net.ParseIP(s); ip != nil {
		return true
	}
	hostPart := low
	if slash := strings.IndexByte(hostPart, '/'); slash >= 0 {
		hostPart = hostPart[:slash]
	}
	if h, p, err := net.SplitHostPort(hostPart); err == nil && isDigits(p) {
		hostPart = h
	}
	if ip := net.ParseIP(hostPart); ip != nil {
		return true
	}
	dot := strings.LastIndex(hostPart, ".")
	if dot <= 0 || dot == len(hostPart)-1 {
		return false
	}
	tld := hostPart[dot+1:]
	if len(tld) < 2 || len(tld) > 24 {
		return false
	}
	for _, r := range tld {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}

// isDigits reports whether s is a non-empty all-digit string (ports).
func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// parseCredentialFileBytes parses one stealer-log password file into
// credential chunks. Supported line shapes:
//   - tab separated:   url \t login \t password [\t extra...]  (RedLine/Vidar/Lumma/Meta)
//   - two tab columns: url \t login:pass
//   - login first:     login \t password \t url
//   - pipe/semicolon:  url | login | password
//   - colon only:      https://site.com/path:login:pass, site.com:login:pass,
//     login:pass (attributed via per-domain file names like
//     "Passwords/instagram.com.txt")
func parseCredentialFileBytes(entryPath, entryName string, raw []byte) []CredentialChunk {
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	raw = bytes.ReplaceAll(raw, []byte{0}, nil)
	if !utf8.Valid(raw) {
		raw = []byte(strings.ToValidUTF8(string(raw), ""))
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}

	// Fallback URL for per-domain password files like "Passwords/instagram.com.txt".
	fileURL := ""
	base := strings.ToLower(entryName)
	if dot := strings.LastIndex(base, "."); dot > 0 {
		base = base[:dot]
	}
	if looksLikeURL(base) {
		fileURL = base
	}

	var chunks []CredentialChunk
	add := func(rawURL, login, pass string) {
		rawURL = cleanCredentialField(rawURL)
		login = cleanCredentialField(login)
		pass = cleanCredentialField(pass)
		if rawURL == "" && fileURL != "" {
			rawURL = fileURL
		}
		if !looksLikeURL(rawURL) {
			return
		}
		dom := NormalizeRootDomain(rawURL)
		if dom == "" {
			return
		}
		if login == "" && pass == "" {
			return
		}
		chunks = append(chunks, CredentialChunk{
			EntryPath: entryPath,
			EntryName: entryName,
			URL:       rawURL,
			Domain:    dom,
			Login:     login,
			Password:  pass,
		})
	}

	rawNormalized := bytes.ReplaceAll(trimmed, []byte("\r\n"), []byte("\n"))
	rawNormalized = bytes.ReplaceAll(rawNormalized, []byte("\r"), []byte("\n"))
	for _, line := range strings.Split(string(rawNormalized), "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		tLow := strings.ToLower(t)
		if strings.HasPrefix(t, "#") || strings.HasPrefix(t, "//") {
			continue
		}
		// Skip column header rows.
		if strings.HasPrefix(tLow, "url\t") || strings.HasPrefix(tLow, "url:") ||
			tLow == "url" || strings.HasPrefix(tLow, "url login") ||
			strings.HasPrefix(tLow, "website\t") || strings.HasPrefix(tLow, "origin\t") {
			continue
		}

		switch {
		case strings.Contains(t, "\t"):
			fields := strings.Split(t, "\t")
			url := strings.TrimSpace(fields[0])
			login := ""
			pass := ""
			if len(fields) >= 2 {
				login = strings.TrimSpace(fields[1])
			}
			if len(fields) >= 3 {
				pass = strings.TrimSpace(fields[2])
			}
			// Two-column variant: url \t login:pass
			if len(fields) == 2 && pass == "" && strings.Contains(login, ":") {
				if ci := strings.Index(login, ":"); ci > 0 {
					pass = login[ci+1:]
					login = login[:ci]
				}
			}
			// Login-first variant: login \t password \t url
			if !looksLikeURL(url) && login != "" && looksLikeURL(pass) {
				url, login, pass = pass, url, login
			}
			add(url, login, pass)

		case strings.Contains(t, "|") || strings.Contains(t, ";"):
			sep := "|"
			if !strings.Contains(t, "|") {
				sep = ";"
			}
			fields := strings.Split(t, sep)
			if len(fields) >= 3 {
				add(strings.TrimSpace(fields[0]), strings.TrimSpace(fields[1]), strings.TrimSpace(fields[2]))
			}

		case strings.Contains(t, ":"):
			login, pass, url, ok := splitColonLine(t)
			if ok {
				add(url, login, pass)
			}

		default:
			// Single token, no separator at all: nothing usable.
		}
	}
	return chunks
}

// splitColonLine parses colon-only credential lines:
//   - "https://site.com/login:mail@x.com:pass" -> login, pass, url, true
//   - "site.com:login:pass"                    -> login, pass, url, true
//   - "login:pass"                             -> login, pass, "", false (caller
//     falls back to the per-domain file URL)
func splitColonLine(t string) (login, pass, url string, ok bool) {
	// 1. URL with scheme: authority is scheme://host[:port]; the credential
	// separator is the first ':' after the first '/' (path), or the first ':'
	// after the host when there is no path.
	if idx := strings.Index(t, "://"); idx >= 0 {
		rest := t[idx+3:]
		slash := strings.Index(rest, "/")
		if slash < 0 {
			// "scheme://host:..." — first colon ends the host.
			ci := strings.Index(rest, ":")
			if ci < 0 {
				return "", "", "", false
			}
			segs := strings.Split(t, ":")
			// segs[0]=scheme, segs[1]=host, segs[2:]=candidate login:pass
			if len(segs) < 4 {
				if len(segs) == 3 && !isDigits(segs[2]) {
					return segs[2], "", t[:idx+3+ci], true // scheme://host:pass
				}
				return "", "", "", false
			}
			if isDigits(segs[2]) {
				// scheme://host:port:login:pass...
				if len(segs) >= 5 {
					return segs[3], strings.Join(segs[4:], ":"), t[:idx+3+ci], true
				}
				return "", "", "", false
			}
			return segs[2], strings.Join(segs[3:], ":"), t[:idx+3+ci], true
		}
		// Path present: parse credential separators from right-to-left so URLs
		// with embedded ':' in path/query parameters are not split mid-URL.
		after := rest[slash+1:]
		lastColon := strings.LastIndex(after, ":")
		if lastColon < 0 {
			return "", "", "", false
		}
		passPart := after[lastColon+1:]
		beforeLast := after[:lastColon]
		prevColon := strings.LastIndex(beforeLast, ":")
		if prevColon < 0 || strings.HasPrefix(beforeLast[prevColon+1:], "//") {
			// "url:pass" — no login
			abs := idx + 3 + slash + 1 + lastColon
			return "", passPart, t[:abs], true
		}
		abs := idx + 3 + slash + 1 + prevColon
		return beforeLast[prevColon+1:], passPart, t[:abs], true
	}

	// 2. No scheme. Split from the left; password may contain colons, so the
	// last segment is the password.
	segs := strings.Split(t, ":")
	if len(segs) < 2 {
		return "", "", "", false
	}
	if looksLikeURL(segs[0]) {
		if len(segs) == 2 {
			if isDigits(segs[1]) {
				return "", "", "", false // "site.com:8080" is just a URL
			}
			return "", segs[1], segs[0], true // site.com:pass (no login)
		}
		if isDigits(segs[1]) {
			// site.com:port[:login]:pass...
			if len(segs) == 3 {
				return "", segs[2], segs[0], true
			}
			return segs[2], strings.Join(segs[3:], ":"), segs[0], true
		}
		return segs[1], strings.Join(segs[2:], ":"), segs[0], true
	}
	// "login:pass[:more]" — attributed to the per-domain file URL if present.
	// ok=true even with url="": add() drops rows whose URL stays unresolvable.
	return segs[0], strings.Join(segs[1:], ":"), "", true
}
