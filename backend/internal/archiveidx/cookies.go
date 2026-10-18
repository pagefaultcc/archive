package archiveidx

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/nwaples/rardecode/v2"
)

// DomainCookieChunk represents all cookies for a single root domain inside one source cookie file.
type DomainCookieChunk struct {
	EntryPath    string
	EntryName    string
	Domain       string
	CookieCount  int
	NetscapeText string
	JSONText     string
}

// JSONCookie is the standard EditThisCookie / J2Team JSON cookie object.
type JSONCookie struct {
	Domain         string `json:"domain"`
	HostOnly       bool   `json:"hostOnly"`
	Path           string `json:"path"`
	Secure         bool   `json:"secure"`
	ExpirationDate int64  `json:"expirationDate"`
	Name           string `json:"name"`
	Value          string `json:"value"`
}

var multiPartTLDs = map[string]bool{
	"co.uk": true, "org.uk": true, "ac.uk": true,
	"com.br": true, "com.pe": true, "gob.pe": true, "edu.pe": true,
	"com.mx": true, "gob.mx": true, "com.ar": true, "com.co": true,
	"com.au": true, "co.jp": true, "co.kr": true, "co.in": true,
	"com.tr": true, "com.tw": true, "com.hk": true, "com.sg": true,
	"com.my": true, "com.ph": true, "com.vn": true, "co.id": true,
	"co.za": true, "com.ua": true, "com.pl": true, "com.es": true,
}

// NormalizeRootDomain reduces a host/domain like ".accounts.google.com" or "chat.openai.com"
// to its clean registrable root domain ("google.com", "openai.com").
func NormalizeRootDomain(host string) string {
	h := strings.Trim(strings.ToLower(host), "\ufeff\u200b\u200c\u200d\u200e\u200f \t\r\n.")
	h = strings.TrimPrefix(h, "http://")
	h = strings.TrimPrefix(h, "https://")
	if idx := strings.IndexByte(h, '/'); idx >= 0 {
		h = h[:idx]
	}
	h = strings.Trim(h, "\ufeff\u200b\u200c\u200d\u200e\u200f \t\r\n.")
	if h == "" {
		return ""
	}
	// IP addresses are already exact root hosts (IPv4 or IPv6)
	if net.ParseIP(h) != nil {
		return h
	}
	// If not pure IPv6, strip port if present (e.g. example.com:8080)
	if strings.Count(h, ":") == 1 {
		if idx := strings.IndexByte(h, ':'); idx >= 0 {
			h = h[:idx]
		}
	}
	if net.ParseIP(h) != nil {
		return h
	}
	if !strings.Contains(h, ".") {
		return ""
	}
	parts := strings.Split(h, ".")
	if len(parts) <= 2 {
		return h
	}
	lastTwo := parts[len(parts)-2] + "." + parts[len(parts)-1]
	if multiPartTLDs[lastTwo] && len(parts) >= 3 {
		return parts[len(parts)-3] + "." + lastTwo
	}
	// Generalized rule for any 2-letter ccTLD with standard second-level domain (co, com, org, net, gov, gob, edu, ac)
	lastPart := parts[len(parts)-1]
	penultimate := parts[len(parts)-2]
	if len(lastPart) == 2 && len(parts) >= 3 {
		switch penultimate {
		case "co", "com", "org", "net", "gov", "gob", "edu", "ac":
			return parts[len(parts)-3] + "." + lastTwo
		}
	}
	return lastTwo
}

// ExtractCookieDomains batch-extracts all cookie text/json files from an archive into a
// temporary folder, parses Netscape and JSON cookies, groups them by root domain per source file,
// and deletes the temporary folder before returning.
func ExtractCookieDomains(
	ctx context.Context,
	filePath, format, password string,
	entries []Entry,
) []DomainCookieChunk {
	var candidates []Entry
	for _, e := range entries {
		if !e.IsDir && e.SizeBytes > 0 && e.SizeBytes <= 15*1024*1024 && isCandidateCookieFile(e.Path, e.Name, e.SizeBytes) {
			candidates = append(candidates, e)
		}
	}
	if len(candidates) == 0 {
		return nil
	}

	cleanPw := strings.Trim(strings.TrimSpace(password), "`'\"")
	// Ultra-fast path: For unencrypted ZIP archives, stream candidate cookie files
	// directly from the central directory in memory in < 2 seconds with 0 temporary disk files!
	if format == "zip" && cleanPw == "" {
		if chunks, ok := extractZipCandidateCookies(filePath, candidates); ok {
			return chunks
		}
	}

	tmpDir, err := os.MkdirTemp("", "cookie-idx-*")
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
						"-ir!*cookie*", "-ir!*browser*", "-ir!*profile*", "-ir!*default*", "-ir!*.json", "-ir!*.txt", "-ir!*.log",
						"-xr!*password*", "-xr!*autofill*", "-xr!*history*", "-xr!*wallet*", "-xr!*screenshot*",
						"-xr!*.exe", "-xr!*.dll", "-xr!*.png", "-xr!*.jpg", "-xr!*.jpeg", "-xr!*.gif", "-xr!*.zip", "-xr!*.rar", "-xr!*.7z",
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
			extractZipCookiesToDir(filePath, tmpDir)
			if !dirHasExtractedFiles(tmpDir, "") && effectivePath != filePath {
				extractZipCookiesToDir(effectivePath, tmpDir)
			}
		} else if format == "rar" {
			for _, p := range pathsToTry {
				for _, pw := range passwordsToTry {
					extractRarCookiesToDir(p, pw, tmpDir)
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

	type diskCookieJob struct {
		fullPath  string
		entryPath string
		entryName string
	}
	var diskJobs []diskCookieJob
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
		if !isCandidateCookieFile(entryPath, entryName, info.Size()) {
			return nil
		}
		diskJobs = append(diskJobs, diskCookieJob{
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

	jobsCh := make(chan diskCookieJob, len(diskJobs))
	for _, j := range diskJobs {
		jobsCh <- j
	}
	close(jobsCh)

	var wg sync.WaitGroup
	resultsCh := make(chan []DomainCookieChunk, numWorkers)
	for range numWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var local []DomainCookieChunk
			for job := range jobsCh {
				raw, rerr := os.ReadFile(job.fullPath)
				if rerr != nil || len(raw) == 0 || !hasCookieSignatures(raw) {
					continue
				}
				chunks := parseCookieFileBytes(job.entryPath, job.entryName, raw)
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

	var result []DomainCookieChunk
	for chunkList := range resultsCh {
		result = append(result, chunkList...)
	}
	return result
}

func isCandidateCookieFile(entryPath, entryName string, size int64) bool {
	if size <= 0 || size > 15*1024*1024 {
		return false
	}
	ln := strings.ToLower(entryName)
	if strings.HasPrefix(ln, "._") || strings.Contains(ln, "restore_data") {
		return false
	}

	// Skip binary / media / archive files
	if strings.HasSuffix(ln, ".exe") || strings.HasSuffix(ln, ".dll") ||
		strings.HasSuffix(ln, ".png") || strings.HasSuffix(ln, ".jpg") ||
		strings.HasSuffix(ln, ".jpeg") || strings.HasSuffix(ln, ".gif") ||
		strings.HasSuffix(ln, ".zip") || strings.HasSuffix(ln, ".rar") ||
		strings.HasSuffix(ln, ".7z") || strings.HasSuffix(ln, ".tar") {
		return false
	}

	// Skip obvious non-cookie stealer files
	if strings.Contains(ln, "password") ||
		strings.Contains(ln, "autofill") ||
		strings.Contains(ln, "history") ||
		strings.Contains(ln, "credit") ||
		strings.Contains(ln, "wallet") ||
		strings.Contains(ln, "screenshot") ||
		strings.Contains(ln, "system") ||
		strings.Contains(ln, "information") ||
		strings.Contains(ln, "installed") ||
		strings.Contains(ln, "process") {
		return false
	}

	lp := "/" + strings.ToLower(entryPath)
	if strings.Contains(lp, "/autofill") ||
		strings.Contains(lp, "/password") ||
		strings.Contains(lp, "/history") ||
		strings.Contains(lp, "/creditcard") ||
		strings.Contains(lp, "/wallet") ||
		strings.Contains(lp, "/soft/") ||
		strings.Contains(lp, "/messengers/") {
		return false
	}

	// Include EVERY .txt, .log, and .json file!
	if strings.HasSuffix(ln, ".txt") || strings.HasSuffix(ln, ".log") || strings.HasSuffix(ln, ".json") {
		return true
	}

	// Extensionless files named Cookies or inside Cookies/Profile/Default/Browser/EBWebView folders
	if !strings.Contains(ln, ".") && (strings.Contains(lp, "cookie") || strings.Contains(lp, "profile") || strings.Contains(lp, "default") || strings.Contains(lp, "browser") || strings.Contains(lp, "ebwebview")) {
		return true
	}
	return false
}

// hasCookieSignatures performs a sub-microsecond pre-check on file bytes
// to determine whether the file could possibly contain Netscape or JSON cookies.
// For plain text files, if there are no tab ('\t') characters in the buffer, it CANNOT be Netscape format.
func hasCookieSignatures(raw []byte) bool {
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")) // Strip UTF-8 BOM
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) < 15 {
		return false
	}

	// 1. JSON check: starts with '[' or '{' and contains cookie keys
	if trimmed[0] == '[' || trimmed[0] == '{' {
		return bytes.Contains(trimmed, []byte(`"domain"`)) ||
			bytes.Contains(trimmed, []byte(`"host"`)) ||
			bytes.Contains(trimmed, []byte(`"Domain"`)) ||
			bytes.Contains(trimmed, []byte(`"Host"`)) ||
			bytes.Contains(trimmed, []byte(`"cookies"`)) ||
			bytes.Contains(trimmed, []byte(`"cookieList"`))
	}

	// 2. Netscape check:
	// A valid Netscape cookie file MUST contain tab characters ('\t').
	// bytes.IndexByte is AVX2 SIMD-accelerated in Go (takes ~0.005ms for a 1MB file).
	if !bytes.Contains(trimmed, []byte{'\t'}) {
		return false
	}

	// 3. Scan lines for Netscape line signature:
	// Line starts with a domain or #HttpOnly_, followed by \t, and column 1 or 3 has TRUE/FALSE/1/0
	idx := 0
	linesScanned := 0
	for idx < len(trimmed) && linesScanned < 100 {
		next := bytes.IndexByte(trimmed[idx:], '\n')
		var lineBytes []byte
		if next < 0 {
			lineBytes = trimmed[idx:]
			idx = len(trimmed)
		} else {
			lineBytes = trimmed[idx : idx+next]
			idx += next + 1
		}
		linesScanned++
		t := bytes.TrimSpace(lineBytes)
		if len(t) == 0 {
			continue
		}
		// Skip normal comments, unless it's #HttpOnly_
		if t[0] == '#' && !bytes.HasPrefix(bytes.ToLower(t), []byte("#httponly_")) {
			continue
		}
		cleanLine := t
		if bytes.HasPrefix(bytes.ToLower(t), []byte("#httponly_")) {
			cleanLine = t[len("#httponly_"):]
		}
		fields := bytes.Split(cleanLine, []byte{'\t'})
		if len(fields) >= 6 {
			dom := bytes.TrimSpace(fields[0])
			flag1 := bytes.ToUpper(bytes.TrimSpace(fields[1]))
			flag3 := bytes.ToUpper(bytes.TrimSpace(fields[3]))
			validFlag1 := bytes.Equal(flag1, []byte("TRUE")) || bytes.Equal(flag1, []byte("FALSE")) || bytes.Equal(flag1, []byte("1")) || bytes.Equal(flag1, []byte("0"))
			validFlag3 := bytes.Equal(flag3, []byte("TRUE")) || bytes.Equal(flag3, []byte("FALSE")) || bytes.Equal(flag3, []byte("1")) || bytes.Equal(flag3, []byte("0"))
			if (validFlag1 || validFlag3) && bytes.Contains(dom, []byte(".")) {
				return true
			}
		}
	}
	return false
}

func dirHasExtractedFiles(dir, ignoreFile string) bool {
	found := false
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d == nil || d.IsDir() {
			return nil
		}
		if ignoreFile != "" && d.Name() == ignoreFile {
			return nil
		}
		if info, ierr := d.Info(); ierr == nil && info.Size() > 0 {
			found = true
			return io.EOF
		}
		return nil
	})
	return found
}

func candidatePasswords(password string) []string {
	seen := make(map[string]bool)
	var out []string
	add := func(pw string) {
		if !seen[pw] {
			seen[pw] = true
			out = append(out, pw)
		}
	}
	cleanPw := strings.Trim(strings.TrimSpace(password), "`'\"")
	if cleanPw != "" {
		add(cleanPw)
	}
	if password != "" && password != cleanPw {
		add(password)
	}
	add("")
	for _, dp := range DefaultPasswords() {
		add(dp)
	}
	return out
}

func extractRarCookiesToDir(filePath, password, tmpDir string) {
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
		if np == "" || !isCandidateCookieFile(np, filepath.Base(np), hdr.UnPackedSize) {
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

func extractZipCookiesToDir(filePath, tmpDir string) {
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
		if np == "" || !isCandidateCookieFile(np, filepath.Base(np), int64(f.UncompressedSize64)) {
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

func extractZipCandidateCookies(filePath string, candidates []Entry) ([]DomainCookieChunk, bool) {
	zr, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, false
	}
	defer zr.Close()

	// 1. Fast single-threaded pass over zip directory entries
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
			if !isCandidateCookieFile(np, base, int64(f.UncompressedSize64)) {
				continue
			}
		} else if !useFilter && !isCandidateCookieFile(np, base, int64(f.UncompressedSize64)) {
			continue
		}
		matchedJobs = append(matchedJobs, fileJob{f: f, np: np, base: base})
	}

	if len(matchedJobs) == 0 {
		return nil, true
	}
	// 2. Parallel worker pool across all available CPU cores
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
	resultsCh := make(chan []DomainCookieChunk, numWorkers)
	var openFailed atomic.Bool

	for range numWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var localChunks []DomainCookieChunk
			for job := range jobsCh {
				rc, err := job.f.Open()
				if err != nil {
					openFailed.Store(true)
					continue
				}
				raw, rerr := io.ReadAll(io.LimitReader(rc, 15*1024*1024))
				_ = rc.Close()
				if rerr != nil || len(raw) == 0 || !hasCookieSignatures(raw) {
					continue
				}
				chunks := parseCookieFileBytes(job.np, job.base, raw)
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

	var totalChunks []DomainCookieChunk
	for chunkList := range resultsCh {
		totalChunks = append(totalChunks, chunkList...)
	}
	if openFailed.Load() && len(totalChunks) == 0 {
		return nil, false
	}
	return totalChunks, true
}

func parseCookieFileBytes(entryPath, entryName string, raw []byte) []DomainCookieChunk {
	// Strip UTF-8 BOM if present and remove null bytes
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	raw = bytes.ReplaceAll(raw, []byte{0}, nil)
	if !utf8.Valid(raw) {
		raw = []byte(strings.ToValidUTF8(string(raw), ""))
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}

	type domainGroup struct {
		netscapeLines []string
		jsonCookies   []JSONCookie
	}
	groups := make(map[string]*domainGroup)
	var domainOrder []string

	addCookie := func(rootDom, netLine string, jc JSONCookie) {
		g, exists := groups[rootDom]
		if !exists {
			g = &domainGroup{}
			groups[rootDom] = g
			domainOrder = append(domainOrder, rootDom)
		}
		g.netscapeLines = append(g.netscapeLines, netLine)
		g.jsonCookies = append(g.jsonCookies, jc)
	}

	// Check if JSON format
	if trimmed[0] == '[' || trimmed[0] == '{' {
		var parsed []map[string]any
		if trimmed[0] == '[' {
			_ = json.Unmarshal(trimmed, &parsed)
		} else {
			var wrapper map[string]any
			if json.Unmarshal(trimmed, &wrapper) == nil {
				for _, k := range []string{"cookies", "data", "cookieList", "items"} {
					if arr, ok := wrapper[k].([]any); ok && len(arr) > 0 {
						for _, it := range arr {
							if m, ok := it.(map[string]any); ok {
								parsed = append(parsed, m)
							}
						}
						break
					}
				}
				// If single cookie object
				if len(parsed) == 0 {
					if _, hasDom := wrapper["domain"]; hasDom {
						parsed = []map[string]any{wrapper}
					} else if _, hasHost := wrapper["host"]; hasHost {
						parsed = []map[string]any{wrapper}
					}
				}
			}
		}
		if len(parsed) > 0 {
			for _, item := range parsed {
				dom, _ := item["domain"].(string)
				if dom == "" {
					dom, _ = item["host"].(string)
				}
				if dom == "" {
					dom, _ = item["Domain"].(string)
				}
				name, _ := item["name"].(string)
				if name == "" {
					name, _ = item["key"].(string)
				}
				if name == "" {
					name, _ = item["Name"].(string)
				}
				if dom == "" || name == "" {
					continue
				}
				rootDom := NormalizeRootDomain(dom)
				if rootDom == "" {
					continue
				}
				pathStr, _ := item["path"].(string)
				if pathStr == "" {
					pathStr, _ = item["Path"].(string)
				}
				if pathStr == "" {
					pathStr = "/"
				}
				var val string
				if v, ok := item["value"].(string); ok {
					val = v
				} else if v, ok := item["Value"].(string); ok {
					val = v
				}
				var sec bool
				switch s := item["secure"].(type) {
				case bool:
					sec = s
				case string:
					sec = strings.EqualFold(s, "true") || s == "1"
				case float64:
					sec = s == 1
				}
				var exp int64
				switch v := item["expirationDate"].(type) {
				case float64:
					exp = int64(v)
				case int64:
					exp = v
				case string:
					if fe, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
						exp = int64(fe)
					}
				}
				if exp == 0 {
					if v, ok := item["expiry"].(float64); ok {
						exp = int64(v)
					} else if v, ok := item["expires"].(float64); ok {
						exp = int64(v)
					}
				}
				includeSub := strings.HasPrefix(dom, ".")
				includeSubStr := "FALSE"
				if includeSub {
					includeSubStr = "TRUE"
				}
				secStr := "FALSE"
				if sec {
					secStr = "TRUE"
				}
				netLine := fmt.Sprintf("%s\t%s\t%s\t%s\t%d\t%s\t%s",
					dom, includeSubStr, pathStr, secStr, exp, name, val)
				jc := JSONCookie{
					Domain:         dom,
					HostOnly:       !includeSub,
					Path:           pathStr,
					Secure:         sec,
					ExpirationDate: exp,
					Name:           name,
					Value:          val,
				}
				addCookie(rootDom, netLine, jc)
			}
		}
	} else {
		// Normalize line endings to \n
		rawNormalized := bytes.ReplaceAll(trimmed, []byte("\r\n"), []byte("\n"))
		rawNormalized = bytes.ReplaceAll(rawNormalized, []byte("\r"), []byte("\n"))
		lines := strings.Split(string(rawNormalized), "\n")
		for _, line := range lines {
			t := strings.TrimSpace(line)
			if t == "" {
				continue
			}
			tLower := strings.ToLower(t)
			if strings.HasPrefix(t, "#") && !strings.HasPrefix(tLower, "#httponly_") {
				continue
			}
			cleanLine := t
			if strings.HasPrefix(tLower, "#httponly_") {
				cleanLine = t[len("#httponly_"):]
			}
			fields := strings.Split(cleanLine, "\t")
			if len(fields) < 6 {
				// Fallback for space-separated cookie columns
				fields = strings.Fields(cleanLine)
				if len(fields) < 6 {
					continue
				}
			}
			dom := strings.TrimSpace(fields[0])
			rootDom := NormalizeRootDomain(dom)
			if rootDom == "" {
				continue
			}
			f1 := strings.TrimSpace(fields[1])
			includeSub := strings.EqualFold(f1, "TRUE") || f1 == "1" || strings.HasPrefix(dom, ".")

			f2 := strings.TrimSpace(fields[2])
			pathStr := f2
			if pathStr == "" || !strings.HasPrefix(pathStr, "/") {
				pathStr = "/"
			}

			f3 := strings.TrimSpace(fields[3])
			sec := strings.EqualFold(f3, "TRUE") || f3 == "1"

			var exp int64
			if fexp, ferr := strconv.ParseFloat(strings.TrimSpace(fields[4]), 64); ferr == nil {
				exp = int64(fexp)
			}

			name := strings.TrimSpace(fields[5])
			if name == "" {
				continue
			}

			var val string
			if len(fields) >= 7 {
				val = strings.Join(fields[6:], "\t")
			}

			includeSubStr := "FALSE"
			if includeSub {
				includeSubStr = "TRUE"
			}
			secStr := "FALSE"
			if sec {
				secStr = "TRUE"
			}
			canonicalNetLine := fmt.Sprintf("%s\t%s\t%s\t%s\t%d\t%s\t%s",
				dom, includeSubStr, pathStr, secStr, exp, name, val)

			jc := JSONCookie{
				Domain:         dom,
				HostOnly:       !includeSub,
				Path:           pathStr,
				Secure:         sec,
				ExpirationDate: exp,
				Name:           name,
				Value:          val,
			}
			addCookie(rootDom, canonicalNetLine, jc)
		}
	}

	if len(domainOrder) == 0 {
		return nil
	}

	chunks := make([]DomainCookieChunk, 0, len(domainOrder))
	for _, dom := range domainOrder {
		g := groups[dom]
		jBytes, _ := json.MarshalIndent(g.jsonCookies, "", "  ")
		chunks = append(chunks, DomainCookieChunk{
			EntryPath:    entryPath,
			EntryName:    entryName,
			Domain:       dom,
			CookieCount:  len(g.netscapeLines),
			NetscapeText: strings.Join(g.netscapeLines, "\n"),
			JSONText:     string(jBytes),
		})
	}
	return chunks
}
