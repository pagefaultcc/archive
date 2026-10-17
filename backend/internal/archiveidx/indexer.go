// Package archiveidx implements zero-extraction archive indexing: it reads
// archive metadata with the 7-Zip (7zz) command-line tool — never extracting
// file contents to disk — with a pure-Go archive/zip fallback when 7zz is not
// installed.
package archiveidx

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nwaples/rardecode/v2"
)

// ErrInvalidPassword reports a wrong password for an encrypted archive.
var ErrInvalidPassword = errors.New("invalid archive password")

// ErrIndex reports a corrupt or unparseable archive.
var ErrIndex = errors.New("archive indexing failed")

// ErrNoTool reports that no 7-Zip binary is available for a format the
// pure-Go fallback cannot handle.
var ErrNoTool = errors.New("7zz (7-Zip) is required to index this archive format")

// Entry is one indexed archive member.
type Entry struct {
	Path        string
	ParentPath  string
	Name        string
	IsDir       bool
	SizeBytes   int64
	PackedBytes int64
	CRC32       string
	Encrypted   bool
	ModifiedAt  *time.Time
}

type Result struct {
	Format           string
	Entries          []Entry
	IsEncrypted      bool
	HeaderEncrypted  bool
	PasswordRequired bool
	MatchedPassword  string
}

var (
	passwordsMu      sync.RWMutex
	currentPasswords = []string{
		"@HUNTER_CLOUD",
		"@updh1",
		"@fatetraffic",
		"@darkside_cloud_info",
		"@HUNTER_CLOUDS",
		"@UP_DAISYCLOUD",
		"https://t.me/AhegaoCloud",
		"@BurnCloudLogs",
		"@PIXELCLOUD3",
		"@TXTMASTER_PUBLIC",
		"infected",
		"1234",
		"12345",
		"password",
	}
)

// DefaultPasswords returns a copy of the active fast password dictionary.
func DefaultPasswords() []string {
	passwordsMu.RLock()
	defer passwordsMu.RUnlock()
	cp := make([]string, len(currentPasswords))
	copy(cp, currentPasswords)
	return cp
}

// SetDefaultPasswords updates the active password dictionary in memory.
func SetDefaultPasswords(pws []string) {
	passwordsMu.Lock()
	defer passwordsMu.Unlock()
	seen := make(map[string]bool)
	var clean []string
	for _, p := range pws {
		t := strings.TrimSpace(p)
		if t != "" && !seen[t] {
			seen[t] = true
			clean = append(clean, t)
		}
	}
	currentPasswords = clean
}
// DetectFormat validates the lowercase file extension and the magic header
// bytes and returns "zip", "7z", or "rar".
func DetectFormat(filename string, header []byte) (string, error) {
	ext := strings.ToLower(path.Ext(filename))
	switch ext {
	case ".zip":
		for _, magic := range [][]byte{
			{'P', 'K', 0x03, 0x04},
			{'P', 'K', 0x05, 0x06},
			{'P', 'K', 0x07, 0x08},
		} {
			if bytes.HasPrefix(header, magic) {
				return "zip", nil
			}
		}
	case ".7z":
		if bytes.HasPrefix(header, []byte{'7', 'z', 0xBC, 0xAF, 0x27, 0x1C}) {
			return "7z", nil
		}
	case ".rar":
		if bytes.HasPrefix(header, []byte{'R', 'a', 'r', '!', 0x1A, 0x07, 0x00}) ||
			bytes.HasPrefix(header, []byte{'R', 'a', 'r', '!', 0x1A, 0x07, 0x01, 0x00}) {
			return "rar", nil
		}
	default:
		return "", fmt.Errorf("%w: unsupported extension %q", ErrIndex, ext)
	}
	return "", fmt.Errorf("%w: header does not match extension %q", ErrIndex, ext)
}

// lookPath and run7z are swappable in tests.
var (
	lookPath = exec.LookPath
	run7z    = run7zExec
)

func sevenZBin() (string, bool) {
	for _, name := range []string{"7zz", "7z", "7za"} {
		if p, err := lookPath(name); err == nil {
			return p, true
		}
	}
	return "", false
}

// IndexFile indexes the archive at filePath without ever extracting entries to
// disk. An empty password means "no password supplied"; 7zz is always invoked
// with -p<pw> (empty included) so it can never prompt on stdin.
func IndexFile(ctx context.Context, filePath, format, password string) (Result, error) {
	res := Result{Format: format}
	bin, ok := sevenZBin()
	if !ok {
		if format == "rar" {
			return indexRarGo(filePath, password)
		}
		if format == "zip" {
			return indexZipGo(filePath)
		}
		return res, fmt.Errorf("%w: %s", ErrNoTool, format)
	}
	args := []string{"l", "-slt", "-p" + password, "--", filePath}
	entries, out, err := run7zListing(ctx, bin, args)
	if len(entries) > 0 {
		firstEncryptedPath := ""
		for _, e := range entries {
			if e.Encrypted {
				res.IsEncrypted = true
				if !e.IsDir && firstEncryptedPath == "" {
					firstEncryptedPath = e.Path
				}
			}
		}
		if !res.IsEncrypted {
			res.Entries = entries
			return res, nil
		}
		// Entries are encrypted. Fast cloud dictionary probe:
		for _, cand := range DefaultPasswords() {
			if verify(ctx, bin, filePath, cand, firstEncryptedPath) == nil {
				res.MatchedPassword = cand
				res.PasswordRequired = false
				res.Entries = entries
				return res, nil
			}
		}
		if password == "" {
			res.PasswordRequired = true
			res.Entries = nil
			return res, nil
		}
		if err := verify(ctx, bin, filePath, password, firstEncryptedPath); err != nil {
			return res, err
		}
		res.Entries = entries
		return res, nil
	}

	if err != nil {
		if isPasswordError(out) {
			res.IsEncrypted = true
			res.HeaderEncrypted = true
			for _, cand := range DefaultPasswords() {
				entriesCand, _, errCand := run7zListing(ctx, bin, []string{"l", "-slt", "-p" + cand, "--", filePath})
				if errCand == nil && len(entriesCand) > 0 {
					res.MatchedPassword = cand
					res.PasswordRequired = false
					res.Entries = entriesCand
					return res, nil
				}
			}
			if password == "" {
				res.PasswordRequired = true
				return res, nil
			}
			return res, ErrInvalidPassword
		}
		if format == "zip" {
			if zres, zerr := indexZipGo(filePath); zerr == nil && len(zres.Entries) > 0 {
				return zres, nil
			}
		}
		return res, fmt.Errorf("%w: listing: %v (%s)", ErrIndex, err, strings.TrimSpace(string(out)))
	}
	res.Entries = entries
	return res, nil
}

// verify runs `7z t` on the first encrypted entry (or the archive if none) to
// validate the password in memory without decompressing the entire archive.
func verify(ctx context.Context, bin, filePath, password, targetEntry string) error {
	args := []string{"t", "-spd", "-p" + password}
	if targetEntry != "" {
		args = append(args, "-i!"+targetEntry)
	}
	args = append(args, "--", filePath)
	out, err := run7z(ctx, bin, args)
	if err != nil {
		if isPasswordError(out) {
			return ErrInvalidPassword
		}
		return fmt.Errorf("%w: verify: %v", ErrIndex, err)
	}
	return nil
}

func run7zExec(ctx context.Context, bin string, args []string) ([]byte, error) {
	finalArgs := make([]string, 0, len(args)+1)
	hasMmt := false
	for _, a := range args {
		if strings.HasPrefix(a, "-mmt") {
			hasMmt = true
			break
		}
	}
	if !hasMmt {
		finalArgs = append(finalArgs, "-mmt=on")
	}
	finalArgs = append(finalArgs, args...)
	cmd := exec.CommandContext(ctx, bin, finalArgs...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	cmd.Stdin = nil // never read stdin; -p is always supplied so no prompt
	err := cmd.Run()
	return buf.Bytes(), err
}

func run7zListing(ctx context.Context, bin string, args []string) ([]Entry, []byte, error) {
	finalArgs := make([]string, 0, len(args)+1)
	hasMmt := false
	for _, a := range args {
		if strings.HasPrefix(a, "-mmt") {
			hasMmt = true
			break
		}
	}
	if !hasMmt {
		finalArgs = append(finalArgs, "-mmt=on")
	}
	finalArgs = append(finalArgs, args...)
	cmd := exec.CommandContext(ctx, bin, finalArgs...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		return nil, stderr.Bytes(), err
	}
	var headBuf bytes.Buffer
	entries, perr := parseListingStream(stdout, &headBuf)
	werr := cmd.Wait()
	if stderr.Len() > 0 {
		headBuf.WriteByte('\n')
		headBuf.Write(stderr.Bytes())
	}
	if werr != nil {
		return entries, headBuf.Bytes(), werr
	}
	return entries, headBuf.Bytes(), perr
}

// isPasswordError detects 7-Zip's wrong-password diagnostics in its output.
func isPasswordError(out []byte) bool {
	lower := strings.ToLower(string(out))
	return strings.Contains(lower, "wrong password") ||
		strings.Contains(lower, "can not open encrypted archive") ||
		strings.Contains(lower, "cannot open encrypted archive") ||
		strings.Contains(lower, "data error in encrypted file") ||
		strings.Contains(lower, "enter password") ||
		strings.Contains(lower, "is encrypted")
}

// parseListing parses `7z l -slt` technical blocks separated by blank lines.
func parseListing(out []byte) ([]Entry, error) {
	return parseListingStream(bytes.NewReader(out), nil)
}

func parseListingStream(r io.Reader, diag *bytes.Buffer) ([]Entry, error) {
	var entries []Entry
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var cur map[string]string
	inEntries := false
	flush := func() {
		defer func() { cur = nil }()
		if len(cur) == 0 || !inEntries {
			return
		}
		if _, hasType := cur["type"]; hasType {
			return
		}
		if p := cur["path"]; p != "" {
			entries = append(entries, entryFromKeys(cur))
		}
	}
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "----------") {
			cur = nil
			inEntries = true
			continue
		}
		if !inEntries && diag != nil && diag.Len() < 16*1024 {
			diag.WriteString(line)
			diag.WriteByte('\n')
		}
		if trimmed == "" {
			flush()
			continue
		}
			if cur == nil {
				cur = map[string]string{}
			}
			cur[strings.ToLower(strings.TrimSpace(k))] = v
		}
	}
	flush()
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("%w: reading listing: %v", ErrIndex, err)
	}
	return normalizeTree(entries), nil
}

// entryFromKeys builds an Entry from one -slt block.
func entryFromKeys(cur map[string]string) Entry {
	raw := cur["path"]
	raw = strings.Trim(raw, "\"")
	isDir := cur["folder"] == "+" ||
		strings.Contains(strings.ToUpper(cur["attributes"]), "D") ||
		strings.HasSuffix(raw, "/") ||
		strings.HasSuffix(raw, "\\")
	size, _ := strconv.ParseInt(strings.TrimSpace(cur["size"]), 10, 64)
	packed, _ := strconv.ParseInt(strings.TrimSpace(cur["packed size"]), 10, 64)
	var mod *time.Time
	if v := cur["modified"]; v != "" {
		if t, err := timeParse(v); err == nil {
			mod = t
		}
	}
	return Entry{
		Path:        raw,
		IsDir:       isDir,
		SizeBytes:   size,
		PackedBytes: packed,
		CRC32:       strings.ToUpper(strings.TrimSpace(cur["crc"])),
		Encrypted:   cur["encrypted"] == "+",
		ModifiedAt:  mod,
	}
}

// timeParse accepts the timestamp layouts 7-Zip emits.
var timeParse = func(value string) (*time.Time, error) {
	for _, layout := range []string{
		"2006-01-02 15:04:05",
		"2006-01-02 15:04:05.000",
		"2006-01-02 15:04:05 -07:00",
		time.RFC3339,
	} {
		if t, err := time.Parse(layout, value); err == nil {
			return &t, nil
		}
	}
	return nil, fmt.Errorf("unparseable timestamp %q", value)
}

// normalizeTree splits raw 7-Zip paths into path/parentPath/name, deduplicates
// rows, and synthesizes implicit parent directory rows so folder-tree
// navigation works for archives that only list leaf file paths
// (a/b/c.txt -> also yields a and a/b).
func normalizeTree(entries []Entry) []Entry {
	seenDirs := map[string]bool{}
	seenFiles := map[string]bool{}
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		p := normalizePath(e.Path)
		if p == "" {
			continue
		}
		e.Path = p
		e.ParentPath = parentOf(p)
		e.Name = baseOf(p)
		if e.IsDir {
			if seenDirs[p] {
				continue
			}
			seenDirs[p] = true
		} else {
			if seenFiles[p] {
				continue
			}
			seenFiles[p] = true
		}
		out = append(out, e)
	}
	// Synthesize implicit parent directories after the leaf pass so real rows
	// keep their metadata; synthesized rows carry names only.
	for _, e := range entries {
		p := normalizePath(e.Path)
		for i := 1; i < len(p); i++ {
			if p[i] != '/' {
				continue
			}
			dirPath := p[:i]
			if seenDirs[dirPath] {
				continue
			}
			seenDirs[dirPath] = true
			out = append(out, Entry{
				Path:       dirPath,
				ParentPath: parentOf(dirPath),
				Name:       baseOf(dirPath),
				IsDir:      true,
			})
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizePath(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	if strings.TrimSpace(p) == "" {
		return ""
	}
	p = path.Clean("/" + p)
	p = strings.TrimPrefix(p, "/")
	if p == "" || p == "." || strings.HasPrefix(p, "../") || strings.Contains(p, "/../") {
		return ""
	}
	return p
}

func parentOf(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[:i]
	}
	return ""
}

func baseOf(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// indexZipGo is the pure-Go fallback for ZIP archives when no 7-Zip binary is
// installed (unit-test environments). It reads central-directory metadata only.
func indexZipGo(filePath string) (Result, error) {
	zr, err := zip.OpenReader(filePath)
	if err != nil {
		return Result{Format: "zip"}, fmt.Errorf("%w: opening zip: %v", ErrIndex, err)
	}
	defer zr.Close()

	res := Result{Format: "zip"}
	var raw []Entry
	for _, f := range zr.File {
		isDir := f.FileInfo().IsDir() ||
			strings.HasSuffix(f.Name, "/") ||
			strings.HasSuffix(f.Name, "\\")
		e := Entry{
			Path:        f.Name,
			IsDir:       isDir,
			SizeBytes:   int64(f.UncompressedSize64),
			PackedBytes: int64(f.CompressedSize64),
			CRC32:       strings.ToUpper(fmt.Sprintf("%08X", f.CRC32)),
			Encrypted:   f.Flags&0x1 != 0,
		}
		if !f.Modified.IsZero() {
			t := f.Modified
			e.ModifiedAt = &t
		}
		if e.Encrypted {
			res.IsEncrypted = true
		}
		raw = append(raw, e)
	}
	entries := normalizeTree(raw)
	if res.IsEncrypted {
		// Without a password the Go fallback cannot list entry contents;
		// directory metadata is still readable but the upload handler treats
		// encrypted archives without a password as password_required.
		res.PasswordRequired = true
		res.Entries = nil
		return res, nil
	}
	res.Entries = entries
	return res, nil
}

// ResolvePrimaryArchiveVolume inspects filePath. If it represents a secondary volume
// of a split multi-part archive (e.g. name.part02.rar, name.part2.rar, name.r01, name.part2.zip),
// it checks whether the primary volume (name.part01.rar, name.part1.rar, name.rar, name.part1.zip)
// exists in the same directory. If found, it returns the primary volume's path so decompression
// engines (like 7zz) can open the archive set from volume 1 and traverse all parts cleanly.
func ResolvePrimaryArchiveVolume(filePath string) string {
	dir := filepath.Dir(filePath)
	base := filepath.Base(filePath)

	// Case 1: .part02.rar, .part2.rar, .part02.zip, .part2.zip, .part02.7z
	rePart := regexp.MustCompile(`(?i)(.*)\.part0*([2-9]|\d{2,})\.(rar|zip|7z)$`)
	if m := rePart.FindStringSubmatch(base); m != nil {
		prefix := m[1]
		ext := m[3]
		cand01 := filepath.Join(dir, fmt.Sprintf("%s.part01.%s", prefix, ext))
		if _, err := os.Stat(cand01); err == nil {
			return cand01
		}
		cand1 := filepath.Join(dir, fmt.Sprintf("%s.part1.%s", prefix, ext))
		if _, err := os.Stat(cand1); err == nil {
			return cand1
		}
		candBase := filepath.Join(dir, fmt.Sprintf("%s.%s", prefix, ext))
		if _, err := os.Stat(candBase); err == nil {
			return candBase
		}
	}

	// Case 2: space part 2.zip / space part 2.rar (e.g. "AYANKOUJI PRIVATE #602 part 2.zip")
	reSpacePart := regexp.MustCompile(`(?i)(.*[\s_-])part0*([2-9]|\d{2,})\.(rar|zip|7z)$`)
	if m := reSpacePart.FindStringSubmatch(base); m != nil {
		prefix := m[1]
		ext := m[3]
		cand01 := filepath.Join(dir, fmt.Sprintf("%spart01.%s", prefix, ext))
		if _, err := os.Stat(cand01); err == nil {
			return cand01
		}
		cand1 := filepath.Join(dir, fmt.Sprintf("%spart1.%s", prefix, ext))
		if _, err := os.Stat(cand1); err == nil {
			return cand1
		}
	}

	// Case 3: old-style RAR volume extensions (.r00, .r01, .r02...)
	reOldRar := regexp.MustCompile(`(?i)(.*)\.r\d{2}$`)
	if m := reOldRar.FindStringSubmatch(base); m != nil {
		prefix := m[1]
		candRar := filepath.Join(dir, prefix+".rar")
		if _, err := os.Stat(candRar); err == nil {
			return candRar
		}
	}

	return filePath
}

// ReadEntry streams up to maxBytes of a single file entry from the archive into
// memory without writing any temporary file to disk.
func ReadEntry(ctx context.Context, filePath, format, password, entryPath string, maxBytes int64) ([]byte, bool, error) {
	clean := normalizePath(entryPath)
	if clean == "" {
		return nil, false, ErrIndex
	}
	if maxBytes <= 0 {
		maxBytes = 512 * 1024
	}

	effectivePath := ResolvePrimaryArchiveVolume(filePath)

	var passwordsToTry []string
	cleanPw := strings.Trim(strings.TrimSpace(password), "`'\"")
	if cleanPw != "" {
		passwordsToTry = append(passwordsToTry, cleanPw)
	}
	if password != cleanPw && password != "" {
		passwordsToTry = append(passwordsToTry, password)
	}
	if len(passwordsToTry) == 0 {
		passwordsToTry = append(passwordsToTry, "")
		passwordsToTry = append(passwordsToTry, DefaultPasswords()...)
	}

	bin, ok := sevenZBin()
	var sawPasswordError bool

	if ok {
		pathsToTry := []string{effectivePath}
		if effectivePath != filePath {
			pathsToTry = append(pathsToTry, filePath)
		}

		for _, p := range pathsToTry {
			for _, pw := range passwordsToTry {
				cctx, cancel := context.WithCancel(ctx)
				cmd := exec.CommandContext(cctx, bin,
					"x", "-so", "-spd", "-bse2", "-p"+pw, "-i!"+clean, "--", p,
				)
				stdout, err := cmd.StdoutPipe()
				if err != nil {
					cancel()
					continue
				}
				var stderr bytes.Buffer
				cmd.Stderr = &stderr
				cmd.Stdin = nil

				if serr := cmd.Start(); serr != nil {
					cancel()
					continue
				}

				data, rerr := io.ReadAll(io.LimitReader(stdout, maxBytes+1))
				truncated := int64(len(data)) > maxBytes
				if truncated {
					data = data[:maxBytes]
					cancel()
				} else {
					cancel()
				}
				_ = cmd.Wait()

				if rerr == nil && len(data) > 0 {
					return data, truncated, nil
				}

				if isPasswordError(stderr.Bytes()) {
					sawPasswordError = true
				}
			}
		}
	}

	// Fallback: Pure Go readers
	if format == "zip" {
		if data, trunc, err := readZipEntryGo(filePath, clean, maxBytes); err == nil && len(data) > 0 {
			return data, trunc, nil
		}
		if effectivePath != filePath {
			if data, trunc, err := readZipEntryGo(effectivePath, clean, maxBytes); err == nil && len(data) > 0 {
				return data, trunc, nil
			}
		}
	}

	if format == "rar" {
		for _, pw := range passwordsToTry {
			if data, trunc, err := readRarEntryGo(effectivePath, pw, clean, maxBytes); err == nil && len(data) > 0 {
				return data, trunc, nil
			}
			if effectivePath != filePath {
				if data, trunc, err := readRarEntryGo(filePath, pw, clean, maxBytes); err == nil && len(data) > 0 {
					return data, trunc, nil
				}
			}
		}
	}

	if sawPasswordError {
		return nil, false, ErrInvalidPassword
	}

	return nil, false, fmt.Errorf("this file cannot be extracted from this archive volume (split archive missing preceding parts or file data damaged)")
}

func readZipEntryGo(filePath, clean string, maxBytes int64) ([]byte, bool, error) {
	zr, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, false, err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if normalizePath(f.Name) == clean {
			rc, err := f.Open()
			if err != nil {
				return nil, false, err
			}
			defer rc.Close()
			data, err := io.ReadAll(io.LimitReader(rc, maxBytes+1))
			if err != nil {
				return nil, false, err
			}
			if int64(len(data)) > maxBytes {
				return data[:maxBytes], true, nil
			}
			return data, false, nil
		}
	}
	return nil, false, ErrIndex
}

// StageDownload extracts a single folder or file from the archive into a
// temporary staging directory under tmpRoot, packages it (into a .zip when
// isDir or asZip is true, or as the raw file otherwise), and schedules
// automatic deletion from tmpRoot after ttl.
func StageDownload(
	ctx context.Context,
	filePath, format, password, entryPath string,
	isDir, asZip bool,
	tmpRoot string,
	ttl time.Duration,
) (stagedPath, downloadName string, err error) {
	clean := normalizePath(entryPath)
	if clean == "" {
		return "", "", ErrIndex
	}
	if tmpRoot == "" {
		tmpRoot = filepath.Join(os.TempDir(), "archive-downloads")
	}
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	if err := os.MkdirAll(tmpRoot, 0o755); err != nil {
		return "", "", err
	}
	sweepExpiredTmpDirs(tmpRoot, ttl)

	jobDir, err := os.MkdirTemp(tmpRoot, "dl-*")
	if err != nil {
		return "", "", err
	}
	extractDir := filepath.Join(jobDir, "extract")
	if err := os.MkdirAll(extractDir, 0o755); err != nil {
		_ = os.RemoveAll(jobDir)
		return "", "", err
	}

	if err := extractTarget(ctx, filePath, format, password, clean, isDir, extractDir); err != nil {
		_ = os.RemoveAll(jobDir)
		return "", "", err
	}

	base := baseOf(clean)
	if base == "" {
		base = "archive-selection"
	}

	var outPath string
	if isDir || asZip {
		if !strings.HasSuffix(strings.ToLower(base), ".zip") {
			downloadName = base + ".zip"
		} else {
			downloadName = base
		}
		outPath = filepath.Join(jobDir, downloadName)
		srcRoot := filepath.Join(extractDir, filepath.FromSlash(clean))
		if _, serr := os.Stat(srcRoot); serr != nil {
			srcRoot = extractDir
		}
		if err := zipPathToFile(srcRoot, base, outPath); err != nil {
			_ = os.RemoveAll(jobDir)
			return "", "", err
		}
		_ = os.RemoveAll(extractDir)
	} else {
		downloadName = base
		srcFile := filepath.Join(extractDir, filepath.FromSlash(clean))
		outPath = filepath.Join(jobDir, downloadName)
		if err := os.Rename(srcFile, outPath); err != nil {
			// Search extractDir if 7-zip extracted with different casing or directory layout
			found := false
			_ = filepath.Walk(extractDir, func(p string, fi os.FileInfo, werr error) error {
				if werr == nil && !fi.IsDir() && strings.EqualFold(fi.Name(), base) {
					if rerr := os.Rename(p, outPath); rerr == nil {
						found = true
						return io.EOF
					}
				}
				return nil
			})
			if !found {
				_ = os.RemoveAll(jobDir)
				return "", "", fmt.Errorf("extracted file %s not found: %w", base, err)
			}
		}
		_ = os.RemoveAll(extractDir)
	}

	// Schedule automatic deletion from /tmp after ttl.
	time.AfterFunc(ttl, func() {
		_ = os.RemoveAll(jobDir)
	})
	return outPath, downloadName, nil
}

func extractTarget(ctx context.Context, filePath, format, password, clean string, isDir bool, extractDir string) error {
	effectivePath := ResolvePrimaryArchiveVolume(filePath)

	var passwordsToTry []string
	cleanPw := strings.Trim(strings.TrimSpace(password), "`'\"")
	if cleanPw != "" {
		passwordsToTry = append(passwordsToTry, cleanPw)
	}
	if password != cleanPw && password != "" {
		passwordsToTry = append(passwordsToTry, password)
	}
	if len(passwordsToTry) == 0 {
		passwordsToTry = append(passwordsToTry, "")
		passwordsToTry = append(passwordsToTry, DefaultPasswords()...)
	}

	bin, ok := sevenZBin()
	var sawPasswordError bool

	if ok {
		pathsToTry := []string{effectivePath}
		if effectivePath != filePath {
			pathsToTry = append(pathsToTry, filePath)
		}

		for _, p := range pathsToTry {
			for _, pw := range passwordsToTry {
				args := []string{
					"x", "-y", "-spd", "-bso0", "-bse1", "-p" + pw,
					"-o" + extractDir,
					"-i!" + clean,
				}
				if isDir {
					args = append(args, "-i!"+clean+"/*")
				}
				args = append(args, "--", p)
				out, err := run7z(ctx, bin, args)

				targetPath := filepath.Join(extractDir, filepath.FromSlash(clean))
				if stat, serr := os.Stat(targetPath); serr == nil && (stat.IsDir() || stat.Size() > 0) {
					return nil
				}

				if err != nil && isPasswordError(out) {
					sawPasswordError = true
				}
			}
		}
	}

	if format == "rar" {
		for _, pw := range passwordsToTry {
			if err := extractRarTargetGo(effectivePath, pw, clean, isDir, extractDir); err == nil {
				return nil
			}
			if effectivePath != filePath {
				if err := extractRarTargetGo(filePath, pw, clean, isDir, extractDir); err == nil {
					return nil
				}
			}
		}
	}

	if format == "zip" {
		zr, err := zip.OpenReader(filePath)
		if err == nil {
			defer zr.Close()
			prefix := clean + "/"
			cleanTmp := filepath.Clean(extractDir) + string(filepath.Separator)
			for _, f := range zr.File {
				np := normalizePath(f.Name)
				if np == "" || (np != clean && (!isDir || !strings.HasPrefix(np, prefix))) {
					continue
				}
				dest := filepath.Join(extractDir, filepath.FromSlash(np))
				cleanDest := filepath.Clean(dest)
				if !strings.HasPrefix(cleanDest, cleanTmp) {
					continue
				}
				if f.FileInfo().IsDir() || strings.HasSuffix(f.Name, "/") {
					_ = os.MkdirAll(cleanDest, 0o755)
					continue
				}
				_ = os.MkdirAll(filepath.Dir(cleanDest), 0o755)
				rc, oerr := f.Open()
				if oerr != nil {
					continue
				}
				wf, cerr := os.Create(cleanDest)
				if cerr != nil {
					_ = rc.Close()
					continue
				}
				_, _ = io.Copy(wf, rc)
				_ = wf.Close()
				_ = rc.Close()
			}
			targetPath := filepath.Join(extractDir, filepath.FromSlash(clean))
			if stat, serr := os.Stat(targetPath); serr == nil && (stat.IsDir() || stat.Size() > 0) {
				return nil
			}
		}
	}

	if sawPasswordError {
		return ErrInvalidPassword
	}

	return fmt.Errorf("this entry cannot be extracted from this volume (split archive volume missing preceding parts)")
}

// ExtractBatchToDir extracts a set of normalized entry paths from an archive into
// extractDir using a single 7-Zip invocation (or pure-Go fallback when 7zz is absent).
func ExtractBatchToDir(ctx context.Context, filePath, format, password string, entryPaths []string, extractDir string) error {
	var relPaths []string
	seen := make(map[string]bool, len(entryPaths))
	for _, p := range entryPaths {
		if np := normalizePath(p); np != "" && !seen[np] {
			seen[np] = true
			relPaths = append(relPaths, np)
		}
	}
	if len(relPaths) == 0 {
		return nil
	}

	effectivePath := ResolvePrimaryArchiveVolume(filePath)
	var passwordsToTry []string
	cleanPw := strings.Trim(strings.TrimSpace(password), "`'\"")
	if cleanPw != "" {
		passwordsToTry = append(passwordsToTry, cleanPw)
	}
	if password != cleanPw && password != "" {
		passwordsToTry = append(passwordsToTry, password)
	}
	if len(passwordsToTry) == 0 {
		passwordsToTry = append(passwordsToTry, "")
		passwordsToTry = append(passwordsToTry, DefaultPasswords()...)
	}

	if bin, ok := sevenZBin(); ok {
		listFile, err := os.CreateTemp("", "7z-batch-*.txt")
		if err == nil {
			listFilePath := listFile.Name()
			_, _ = listFile.WriteString(strings.Join(relPaths, "\n") + "\n")
			_ = listFile.Close()
			defer os.Remove(listFilePath)

			pathsToTry := []string{effectivePath}
			if effectivePath != filePath {
				pathsToTry = append(pathsToTry, filePath)
			}
			for _, p := range pathsToTry {
				for _, pw := range passwordsToTry {
					args := []string{
						"x", "-y", "-spd", "-bso0", "-bse0", "-mmt=on",
						"-p" + pw,
						"-o" + extractDir,
						"@" + listFilePath,
						"--", p,
					}
					if _, err := run7z(ctx, bin, args); err == nil {
						return nil
					}
				}
			}
		}
	}

	if format == "zip" {
		zr, err := zip.OpenReader(filePath)
		if err == nil {
			defer zr.Close()
			cleanTmp := filepath.Clean(extractDir) + string(filepath.Separator)
			for _, f := range zr.File {
				if f.FileInfo().IsDir() {
					continue
				}
				np := normalizePath(f.Name)
				if np == "" || !seen[np] {
					continue
				}
				dest := filepath.Join(extractDir, filepath.FromSlash(np))
				cleanDest := filepath.Clean(dest)
				if !strings.HasPrefix(cleanDest, cleanTmp) {
					continue
				}
				_ = os.MkdirAll(filepath.Dir(cleanDest), 0o755)
				rc, oerr := f.Open()
				if oerr != nil {
					continue
				}
				wf, cerr := os.Create(cleanDest)
				if cerr == nil {
					_, _ = io.Copy(wf, io.LimitReader(rc, 50*1024*1024))
					_ = wf.Close()
				}
				_ = rc.Close()
			}
			return nil
		}
	}

	if format == "rar" {
		for _, pw := range passwordsToTry {
			for _, np := range relPaths {
				_ = extractRarTargetGo(effectivePath, pw, np, false, extractDir)
			}
		}
	}
	return nil
}

func zipPathToFile(srcRoot, rootName, destZip string) error {
	zf, err := os.Create(destZip)
	if err != nil {
		return err
	}
	defer zf.Close()
	zw := zip.NewWriter(zf)
	defer zw.Close()

	info, err := os.Stat(srcRoot)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = rootName
		hdr.Method = zip.Deflate
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		rf, err := os.Open(srcRoot)
		if err != nil {
			return err
		}
		defer rf.Close()
		_, err = io.Copy(w, rf)
		return err
	}

	return filepath.WalkDir(srcRoot, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(srcRoot, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		zipName := path.Join(rootName, filepath.ToSlash(rel))
		if d.IsDir() {
			_, err := zw.Create(zipName + "/")
			return err
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		hdr, err := zip.FileInfoHeader(fi)
		if err != nil {
			return err
		}
		hdr.Name = zipName
		hdr.Method = zip.Deflate
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		rf, err := os.Open(p)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(w, rf)
		_ = rf.Close()
		return copyErr
	})
}

func sweepExpiredTmpDirs(tmpRoot string, ttl time.Duration) {
	entries, err := os.ReadDir(tmpRoot)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-ttl)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.RemoveAll(filepath.Join(tmpRoot, entry.Name()))
		}
	}
}

func isRarPasswordErr(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "password") || strings.Contains(s, "encrypted") || strings.Contains(s, "corrupt")
}

func indexRarGo(filePath, password string) (Result, error) {
	res := Result{Format: "rar"}
	var opts []rardecode.Option
	if password != "" {
		opts = append(opts, rardecode.Password(password))
	}
	rc, err := rardecode.OpenReader(filePath, opts...)
	if err != nil {
		if isRarPasswordErr(err) {
			res.IsEncrypted = true
			res.HeaderEncrypted = true
			if password == "" {
				res.PasswordRequired = true
				return res, nil
			}
			return res, ErrInvalidPassword
		}
		return res, fmt.Errorf("%w: opening rar: %v", ErrIndex, err)
	}
	defer rc.Close()

	var raw []Entry
	testedEncryptedFile := false
	for {
		hdr, err := rc.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			if isRarPasswordErr(err) {
				res.IsEncrypted = true
				if password == "" {
					res.PasswordRequired = true
					res.Entries = nil
					return res, nil
				}
				return res, ErrInvalidPassword
			}
			return res, fmt.Errorf("%w: reading rar header: %v", ErrIndex, err)
		}
		var mod *time.Time
		if !hdr.ModificationTime.IsZero() {
			t := hdr.ModificationTime.UTC()
			mod = &t
		}
		e := Entry{
			Path:        hdr.Name,
			IsDir:       hdr.IsDir,
			SizeBytes:   hdr.UnPackedSize,
			PackedBytes: hdr.PackedSize,
			ModifiedAt:  mod,
		}
		if !hdr.IsDir && !testedEncryptedFile {
			var probe [64]byte
			_, rerr := rc.Read(probe[:])
			if rerr != nil && rerr != io.EOF {
				if isRarPasswordErr(rerr) {
					res.IsEncrypted = true
					if password == "" {
						res.PasswordRequired = true
						res.Entries = nil
						return res, nil
					}
					return res, ErrInvalidPassword
				}
			}
			testedEncryptedFile = true
		}
		if password != "" {
			e.Encrypted = true
			res.IsEncrypted = true
		}
		raw = append(raw, e)
	}
	res.Entries = normalizeTree(raw)
	return res, nil
}

func readRarEntryGo(filePath, password, clean string, maxBytes int64) ([]byte, bool, error) {
	var opts []rardecode.Option
	if password != "" {
		opts = append(opts, rardecode.Password(password))
	}
	rc, err := rardecode.OpenReader(filePath, opts...)
	if err != nil {
		return nil, false, err
	}
	defer rc.Close()
	for {
		hdr, err := rc.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, false, err
		}
		if normalizePath(hdr.Name) == clean {
			data, err := io.ReadAll(io.LimitReader(rc, maxBytes+1))
			if err != nil {
				return nil, false, err
			}
			if int64(len(data)) > maxBytes {
				return data[:maxBytes], true, nil
			}
			return data, false, nil
		}
	}
	return nil, false, ErrIndex
}

func extractRarTargetGo(filePath, password, clean string, isDir bool, extractDir string) error {
	var opts []rardecode.Option
	if password != "" {
		opts = append(opts, rardecode.Password(password))
	}
	rc, err := rardecode.OpenReader(filePath, opts...)
	if err != nil {
		return err
	}
	defer rc.Close()
	prefix := clean + "/"
	cleanTmp := filepath.Clean(extractDir) + string(filepath.Separator)
	for {
		hdr, err := rc.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		np := normalizePath(hdr.Name)
		if np == "" || (np != clean && (!isDir || !strings.HasPrefix(np, prefix))) {
			continue
		}
		dest := filepath.Join(extractDir, filepath.FromSlash(np))
		cleanDest := filepath.Clean(dest)
		if !strings.HasPrefix(cleanDest, cleanTmp) {
			continue
		}
		if hdr.IsDir {
			if err := os.MkdirAll(cleanDest, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(cleanDest), 0o755); err != nil {
			return err
		}
		wf, err := os.Create(cleanDest)
		if err != nil {
			return err
		}
		_, cerr := io.Copy(wf, rc)
		_ = wf.Close()
		if cerr != nil {
			return cerr
		}
	}
	return nil
}
