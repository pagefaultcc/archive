package archiveidx

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"github.com/nwaples/rardecode/v2"
)

// CardChunk is one parsed credit/debit card record extracted from a stealer log.
type CardChunk struct {
	EntryPath string
	EntryName string
	Holder    string
	Number    string
	ExpMonth  string
	ExpYear   string
	CVV       string
	Brand     string
}

// ExtractCards batch-extracts stealer-log card files from an archive,
// parses cardholder/number/expiration/cvv records, and returns card chunks.
func ExtractCards(
	ctx context.Context,
	filePath, format, password string,
	entries []Entry,
) []CardChunk {
	var candidates []Entry
	for _, e := range entries {
		if !e.IsDir && e.SizeBytes > 0 && e.SizeBytes <= 15*1024*1024 && isCandidateCardFile(e.Path, e.Name, e.SizeBytes) {
			candidates = append(candidates, e)
		}
	}
	if len(candidates) == 0 {
		return nil
	}

	cleanPw := strings.Trim(strings.TrimSpace(password), "`'\"")
	// Ultra-fast path: stream candidate card files straight from zip central directory in memory
	if format == "zip" && cleanPw == "" {
		if chunks, ok := extractZipCandidateCards(filePath, candidates); ok {
			return chunks
		}
	}

	tmpDir, err := os.MkdirTemp("", "card-idx-*")
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
						"-ir!*creditcard*", "-ir!*credit_card*", "-ir!*cards*", "-ir!*card.txt*", "-ir!*autofill*", "-ir!*.txt", "-ir!*.log",
						"-xr!*.exe", "-xr!*.dll", "-xr!*.png", "-xr!*.jpg",
						"-xr!*.zip", "-xr!*.rar", "-xr!*.7z",
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
			extractZipCardsToDir(filePath, tmpDir)
		} else if format == "rar" {
			for _, pw := range passwordsToTry {
				extractRarCardsToDir(filePath, pw, tmpDir)
				if dirHasExtractedFiles(tmpDir, "") {
					break
				}
			}
		}
	}

	candidateMap := make(map[string]string)
	for _, c := range candidates {
		np := normalizePath(c.Path)
		candidateMap[filepath.FromSlash(np)] = np
		candidateMap[filepath.Base(np)] = np
	}

	var extractedFiles []struct {
		diskPath  string
		entryPath string
		entryName string
	}
	_ = filepath.WalkDir(tmpDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d == nil || d.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(tmpDir, p)
		if rerr != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		origPath, ok := candidateMap[rel]
		if !ok {
			origPath, ok = candidateMap[filepath.Base(rel)]
		}
		if !ok {
			origPath = relSlash
		}
		extractedFiles = append(extractedFiles, struct {
			diskPath  string
			entryPath string
			entryName string
		}{
			diskPath:  p,
			entryPath: origPath,
			entryName: filepath.Base(origPath),
		})
		return nil
	})

	if len(extractedFiles) == 0 {
		return nil
	}

	numWorkers := runtime.GOMAXPROCS(0)
	if numWorkers < 2 {
		numWorkers = 2
	}
	if numWorkers > len(extractedFiles) {
		numWorkers = len(extractedFiles)
	}

	jobsCh := make(chan struct {
		diskPath  string
		entryPath string
		entryName string
	}, len(extractedFiles))
	for _, f := range extractedFiles {
		jobsCh <- f
	}
	close(jobsCh)

	resultsCh := make(chan []CardChunk, numWorkers)
	var wg sync.WaitGroup

	for range numWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var localChunks []CardChunk
			for job := range jobsCh {
				raw, err := os.ReadFile(job.diskPath)
				if err != nil || len(raw) == 0 || !hasCardSignatures(raw) {
					continue
				}
				chunks := parseCardFileBytes(job.entryPath, job.entryName, raw)
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

	var result []CardChunk
	for chunkList := range resultsCh {
		result = append(result, chunkList...)
	}
	return result
}

// isCandidateCardFile reports whether an entry name or path likely contains credit card data.
func isCandidateCardFile(entryPath, entryName string, size int64) bool {
	if size <= 0 || size > 15*1024*1024 {
		return false
	}
	ln := strings.ToLower(entryName)
	if strings.HasPrefix(ln, "._") {
		return false
	}
	for _, ext := range []string{
		".exe", ".dll", ".png", ".jpg", ".jpeg", ".gif", ".zip", ".rar",
		".7z", ".tar", ".gz", ".sqlite", ".sqlite3", ".db", ".pdf",
		".mp4", ".mp3", ".jar", ".ico", ".svg", ".woff", ".woff2",
	} {
		if strings.HasSuffix(ln, ext) {
			return false
		}
	}
	lp := "/" + strings.ToLower(entryPath)
	if strings.Contains(lp, "/history") || strings.Contains(lp, "/bookmarks") {
		return false
	}

	// Candidate all text, log, csv, json, or extensionless files inside the archive
	if strings.HasSuffix(ln, ".txt") || strings.HasSuffix(ln, ".log") ||
		strings.HasSuffix(ln, ".csv") || strings.HasSuffix(ln, ".json") {
		return true
	}
	return !strings.Contains(ln, ".")
}

// hasCardSignatures is a quick check to reject binary/irrelevant blobs.
func hasCardSignatures(raw []byte) bool {
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")) // Strip UTF-8 BOM
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) < 12 {
		return false
	}
	if bytes.HasPrefix(trimmed, []byte("SQLite format 3\x00")) {
		return false
	}
	head := trimmed
	if len(head) > 4096 {
		head = head[:4096]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return false
	}
	// File must contain some digit characters
	for _, b := range head {
		if b >= '0' && b <= '9' {
			return true
		}
	}
	return false
}

func extractZipCardsToDir(filePath, tmpDir string) {
	zr, err := zip.OpenReader(filePath)
	if err != nil {
		return
	}
	defer func() { _ = zr.Close() }()
	cleanTmp := filepath.Clean(tmpDir) + string(filepath.Separator)
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		np := normalizePath(f.Name)
		if np == "" || f.UncompressedSize64 == 0 || f.UncompressedSize64 > 15*1024*1024 {
			continue
		}
		if !isCandidateCardFile(np, filepath.Base(np), int64(f.UncompressedSize64)) {
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
		_ = os.MkdirAll(filepath.Dir(cleanDest), 0o750)
		out, err := os.Create(cleanDest)
		if err == nil {
			_, _ = io.Copy(out, io.LimitReader(rc, 15*1024*1024))
			_ = out.Close()
		}
		_ = rc.Close()
	}
}

func extractRarCardsToDir(filePath, password, tmpDir string) {
	var opts []rardecode.Option
	if password != "" {
		opts = append(opts, rardecode.Password(password))
	}
	rr, err := rardecode.OpenReader(filePath, opts...)
	if err != nil {
		return
	}
	defer func() { _ = rr.Close() }()
	cleanTmp := filepath.Clean(tmpDir) + string(filepath.Separator)
	for {
		header, err := rr.Next()
		if err != nil {
			break
		}
		if header.IsDir {
			continue
		}
		np := normalizePath(header.Name)
		if np == "" || !isCandidateCardFile(np, filepath.Base(np), header.UnPackedSize) {
			continue
		}
		dest := filepath.Join(tmpDir, filepath.FromSlash(np))
		cleanDest := filepath.Clean(dest)
		if !strings.HasPrefix(cleanDest, cleanTmp) {
			continue
		}
		_ = os.MkdirAll(filepath.Dir(cleanDest), 0o750)
		out, err := os.Create(cleanDest)
		if err == nil {
			_, _ = io.Copy(out, io.LimitReader(rr, 15*1024*1024))
			_ = out.Close()
		}
	}
}

func extractZipCandidateCards(filePath string, candidates []Entry) ([]CardChunk, bool) {
	zr, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, false
	}
	defer func() { _ = zr.Close() }()

	candidateMap := make(map[string]string)
	for _, c := range candidates {
		np := normalizePath(c.Path)
		candidateMap[np] = np
	}

	type matchJob struct {
		f    *zip.File
		np   string
		base string
	}
	var jobs []matchJob
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		np := normalizePath(f.Name)
		if np == "" || f.UncompressedSize64 == 0 || f.UncompressedSize64 > 15*1024*1024 {
			continue
		}
		if _, ok := candidateMap[np]; ok {
			jobs = append(jobs, matchJob{f: f, np: np, base: filepath.Base(np)})
			continue
		}
		if isCandidateCardFile(np, filepath.Base(np), int64(f.UncompressedSize64)) {
			jobs = append(jobs, matchJob{f: f, np: np, base: filepath.Base(np)})
		}
	}

	if len(jobs) == 0 {
		return nil, true
	}

	numWorkers := runtime.GOMAXPROCS(0)
	if numWorkers < 2 {
		numWorkers = 2
	}
	if numWorkers > len(jobs) {
		numWorkers = len(jobs)
	}

	jobsCh := make(chan matchJob, len(jobs))
	for _, j := range jobs {
		jobsCh <- j
	}
	close(jobsCh)

	resultsCh := make(chan []CardChunk, numWorkers)
	var openFailed atomic.Bool
	var wg sync.WaitGroup

	for range numWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var localChunks []CardChunk
			for job := range jobsCh {
				rc, err := job.f.Open()
				if err != nil {
					openFailed.Store(true)
					continue
				}
				raw, rerr := io.ReadAll(io.LimitReader(rc, 15*1024*1024))
				_ = rc.Close()
				if rerr != nil || len(raw) == 0 || !hasCardSignatures(raw) {
					continue
				}
				chunks := parseCardFileBytes(job.np, job.base, raw)
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

	var totalChunks []CardChunk
	for chunkList := range resultsCh {
		totalChunks = append(totalChunks, chunkList...)
	}
	if openFailed.Load() && len(totalChunks) == 0 {
		return nil, false
	}
	return totalChunks, true
}

func cleanCardDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// checkLuhn validates a credit or debit card number using the Luhn checksum algorithm (Mod 10).
func checkLuhn(number string) bool {
	digits := cleanCardDigits(number)
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	var sum int
	alternate := false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if alternate {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		alternate = !alternate
	}
	return sum%10 == 0
}

// DetectCardBrand returns the issuer/brand name based on card number prefix.
func DetectCardBrand(number string) string {
	digits := cleanCardDigits(number)
	if len(digits) < 12 {
		return ""
	}
	if strings.HasPrefix(digits, "4") {
		return "Visa"
	}
	if len(digits) >= 2 {
		if p2, err := strconv.Atoi(digits[:2]); err == nil && p2 >= 51 && p2 <= 55 {
			return "Mastercard"
		}
	}
	if len(digits) >= 4 {
		if p4, err := strconv.Atoi(digits[:4]); err == nil && p4 >= 2221 && p4 <= 2720 {
			return "Mastercard"
		}
	}
	if strings.HasPrefix(digits, "34") || strings.HasPrefix(digits, "37") {
		return "American Express"
	}
	if strings.HasPrefix(digits, "6011") || strings.HasPrefix(digits, "65") {
		return "Discover"
	}
	if len(digits) >= 3 {
		if p3, err := strconv.Atoi(digits[:3]); err == nil && p3 >= 644 && p3 <= 649 {
			return "Discover"
		}
	}
	if len(digits) >= 4 {
		if p4, err := strconv.Atoi(digits[:4]); err == nil && p4 >= 3528 && p4 <= 3589 {
			return "JCB"
		}
	}
	if strings.HasPrefix(digits, "36") || strings.HasPrefix(digits, "38") {
		return "Diners Club"
	}
	if strings.HasPrefix(digits, "62") {
		return "UnionPay"
	}
	if len(digits) >= 4 {
		if p4, err := strconv.Atoi(digits[:4]); err == nil && p4 >= 2200 && p4 <= 2204 {
			return "Mir"
		}
	}
	return "Other"
}

func parseExpiration(exp string) (month, year string) {
	exp = strings.TrimSpace(exp)
	if exp == "" {
		return "", ""
	}
	// Shapes: MM/YY, MM/YYYY, MM-YY, MM-YYYY, MM|YY, MM.YYYY
	for _, sep := range []string{"/", "-", "|", "."} {
		if strings.Contains(exp, sep) {
			parts := strings.Split(exp, sep)
			if len(parts) >= 2 {
				m := cleanCardDigits(strings.TrimSpace(parts[0]))
				y := cleanCardDigits(strings.TrimSpace(parts[1]))
				if len(m) == 1 {
					m = "0" + m
				}
				if len(y) == 2 {
					y = "20" + y
				}
				return m, y
			}
		}
	}
	// 4 digits: MMYY
	digits := cleanCardDigits(exp)
	if len(digits) == 4 {
		return digits[:2], "20" + digits[2:]
	}
	if len(digits) == 6 {
		return digits[:2], digits[2:]
	}
	return "", ""
}

// parseCardFileBytes handles key-value blocks, delimited rows, and JSON dumps.
func parseCardFileBytes(entryPath, entryName string, raw []byte) []CardChunk {
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")) // Strip UTF-8 BOM
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}

	// JSON format check
	if (trimmed[0] == '[' || trimmed[0] == '{') && json.Valid(trimmed) {
		if chunks := parseJSONCards(entryPath, entryName, trimmed); len(chunks) > 0 {
			return chunks
		}
	}

	text := string(raw)
	lines := strings.Split(text, "\n")

	var result []CardChunk
	seenNumbers := make(map[string]bool)
	var curHolder, curNumber, curExpMonth, curExpYear, curCVV, curBrand string

	emitCurrent := func() {
		digits := cleanCardDigits(curNumber)
		if len(digits) >= 12 && len(digits) <= 19 {
			brand := curBrand
			if brand == "" || strings.EqualFold(brand, "unknown") {
				brand = DetectCardBrand(digits)
			}
			isLuhn := checkLuhn(digits)
			if (isLuhn || (brand != "" && brand != "Other")) && !seenNumbers[digits] {
				seenNumbers[digits] = true
				result = append(result, CardChunk{
					EntryPath: entryPath,
					EntryName: entryName,
					Holder:    curHolder,
					Number:    digits,
					ExpMonth:  curExpMonth,
					ExpYear:   curExpYear,
					CVV:       curCVV,
					Brand:     brand,
				})
			}
		}
		curHolder = ""
		curNumber = ""
		curExpMonth = ""
		curExpYear = ""
		curCVV = ""
		curBrand = ""
	}

	for _, l := range lines {
		line := strings.TrimSpace(l)
		if line == "" {
			if curNumber != "" {
				emitCurrent()
			}
			continue
		}
		// Separator lines (ASCII and Unicode box drawing ═, ─) or Card headers
		if strings.HasPrefix(line, "===") || strings.HasPrefix(line, "---") || strings.HasPrefix(line, "***") ||
			strings.HasPrefix(line, "═══") || strings.HasPrefix(line, "───") || strings.HasPrefix(line, "___") ||
			strings.HasPrefix(line, "Card ") || strings.HasPrefix(line, "card ") {
			if curNumber != "" {
				emitCurrent()
			}
			continue
		}

		// Check for delimited lines first if not currently in a key-value block
		if curNumber == "" && (strings.Contains(line, "|") || strings.Contains(line, "\t") || strings.Contains(line, ";")) {
			if chunk, ok := parseDelimitedCardLine(entryPath, entryName, line); ok {
				if !seenNumbers[chunk.Number] {
					seenNumbers[chunk.Number] = true
					result = append(result, chunk)
				}
				continue
			}
		}

		// Key-Value parsing
		colonIdx := strings.IndexByte(line, ':')
		if colonIdx > 0 {
			key := strings.ToLower(strings.TrimSpace(line[:colonIdx]))
			val := strings.TrimSpace(line[colonIdx+1:])

			switch key {
			case "card number", "number", "card", "card_number", "cc", "cc number", "card no", "card no.", "pan", "account number":
				if curNumber != "" {
					emitCurrent()
				}
				curNumber = cleanCardDigits(val)
			case "cardholder", "holder", "card holder", "cardholder name", "name", "name on card", "holder name", "owner":
				curHolder = cleanField(val)
			case "expiration", "expiration date", "expire", "exp", "expiry", "exp date", "expiry date", "valid thru", "expires":
				m, y := parseExpiration(val)
				if m != "" {
					curExpMonth = m
				}
				if y != "" {
					curExpYear = y
				}
			case "exp month", "expiration month", "month":
				m := cleanCardDigits(val)
				if len(m) == 1 {
					m = "0" + m
				}
				curExpMonth = m
			case "exp year", "expiration year", "year":
				y := cleanCardDigits(val)
				if len(y) == 2 {
					y = "20" + y
				}
				curExpYear = y
			case "cvv", "cvc", "security code", "code", "cvv2", "cvc2", "cid":
				curCVV = cleanCardDigits(val)
			case "type", "brand", "card type", "network", "issuer":
				curBrand = cleanField(val)
			}
			continue
		}

		// If line is just a bare card number or delimited line
		if chunk, ok := parseDelimitedCardLine(entryPath, entryName, line); ok {
			if curNumber != "" {
				emitCurrent()
			}
			if !seenNumbers[chunk.Number] {
				seenNumbers[chunk.Number] = true
				result = append(result, chunk)
			}
			continue
		}
	}

	if curNumber != "" {
		emitCurrent()
	}

	// Regex scanner pass: find any 13-19 digit card numbers verified with Luhn checksum
	cardRegex := regexp.MustCompile(`\b(?:\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}|\d{13,19})\b`)
	expRegex := regexp.MustCompile(`\b(0[1-9]|1[0-2])[\/\-\|\.](20[2-3][0-9]|[2-3][0-9])\b`)
	cvcRegex := regexp.MustCompile(`(?i)\b(?:CVC|CVV|CID|Code)[:\s]+(\d{3,4})\b`)

	for idx, line := range lines {
		matches := cardRegex.FindAllString(line, -1)
		for _, m := range matches {
			digits := cleanCardDigits(m)
			if len(digits) < 13 || len(digits) > 19 || seenNumbers[digits] {
				continue
			}
			if !checkLuhn(digits) {
				continue
			}
			brand := DetectCardBrand(digits)
			if brand == "" || brand == "Other" {
				continue
			}
			var expM, expY, nearbyCVV string
			start := idx - 2
			if start < 0 {
				start = 0
			}
			end := idx + 3
			if end > len(lines) {
				end = len(lines)
			}
			for j := start; j < end; j++ {
				if expM == "" {
					if expMatch := expRegex.FindStringSubmatch(lines[j]); len(expMatch) >= 3 {
						expM, expY = expMatch[1], expMatch[2]
						if len(expY) == 2 {
							expY = "20" + expY
						}
					}
				}
				if nearbyCVV == "" {
					if cvcMatch := cvcRegex.FindStringSubmatch(lines[j]); len(cvcMatch) >= 2 {
						nearbyCVV = cvcMatch[1]
					}
				}
			}
			seenNumbers[digits] = true
			result = append(result, CardChunk{
				EntryPath: entryPath,
				EntryName: entryName,
				Number:    digits,
				ExpMonth:  expM,
				ExpYear:   expY,
				CVV:       nearbyCVV,
				Brand:     brand,
			})
		}
	}

	return result
}

func cleanField(s string) string {
	s = strings.ReplaceAll(s, "\x00", "")
	return strings.Trim(s, "\ufeff\u200b\u200c\u200d\u200e\u200f \t\r\n\"'`")
}

func parseDelimitedCardLine(entryPath, entryName, line string) (CardChunk, bool) {
	var seps = []string{"\t", "|", ";", ","}
	var bestParts []string
	for _, sep := range seps {
		if strings.Contains(line, sep) {
			p := strings.Split(line, sep)
			if len(p) >= 2 && len(p) > len(bestParts) {
				bestParts = p
			}
		}
	}
	if len(bestParts) < 2 {
		return CardChunk{}, false
	}

	var cardNumber, expMonth, expYear, cvv, holder, brand string

	for _, rawPart := range bestParts {
		part := strings.TrimSpace(rawPart)
		digits := cleanCardDigits(part)
		if len(digits) >= 12 && len(digits) <= 19 && cardNumber == "" {
			cardNumber = digits
			continue
		}
		if (strings.Contains(part, "/") || strings.Contains(part, "-")) && expMonth == "" {
			m, y := parseExpiration(part)
			if m != "" && y != "" {
				expMonth, expYear = m, y
				continue
			}
		}
		if (len(digits) == 3 || len(digits) == 4) && cvv == "" && expMonth != "" {
			cvv = digits
			continue
		}
		if len(digits) == 4 && expYear == "" && (strings.HasPrefix(digits, "20") || strings.HasPrefix(digits, "21")) {
			expYear = digits
			continue
		}
		if len(digits) == 2 && expMonth == "" {
			if num, err := strconv.Atoi(digits); err == nil && num >= 1 && num <= 12 {
				expMonth = digits
				continue
			}
		}
		if len(part) > 2 && holder == "" && !strings.ContainsAny(part, "0123456789") {
			holder = cleanField(part)
		}
	}

	if cardNumber == "" {
		return CardChunk{}, false
	}

	brand = DetectCardBrand(cardNumber)

	return CardChunk{
		EntryPath: entryPath,
		EntryName: entryName,
		Holder:    holder,
		Number:    cardNumber,
		ExpMonth:  expMonth,
		ExpYear:   expYear,
		CVV:       cvv,
		Brand:     brand,
	}, true
}

func parseJSONCards(entryPath, entryName string, raw []byte) []CardChunk {
	var items []map[string]any
	if err := json.Unmarshal(raw, &items); err != nil {
		var single map[string]any
		if serr := json.Unmarshal(raw, &single); serr == nil {
			items = []map[string]any{single}
		} else {
			return nil
		}
	}

	var results []CardChunk
	for _, it := range items {
		getString := func(keys ...string) string {
			for _, k := range keys {
				if v, ok := it[k]; ok && v != nil {
					switch val := v.(type) {
					case string:
						return strings.TrimSpace(val)
					case float64:
						return strconv.FormatInt(int64(val), 10)
					}
				}
			}
			return ""
		}

		num := cleanCardDigits(getString("number", "card_number", "cardNumber", "card", "cc"))
		if len(num) < 12 || len(num) > 19 {
			continue
		}

		holder := cleanField(getString("holder", "cardholder", "name", "name_on_card", "cardHolder"))
		exp := getString("expiration", "expiration_date", "expiry", "exp")
		m, y := parseExpiration(exp)
		if m == "" {
			m = cleanCardDigits(getString("exp_month", "expiration_month", "month"))
			if len(m) == 1 {
				m = "0" + m
			}
		}
		if y == "" {
			y = cleanCardDigits(getString("exp_year", "expiration_year", "year"))
			if len(y) == 2 {
				y = "20" + y
			}
		}
		cvv := cleanCardDigits(getString("cvv", "cvc", "security_code", "code"))
		brand := getString("brand", "type", "card_type")
		if brand == "" {
			brand = DetectCardBrand(num)
		}

		results = append(results, CardChunk{
			EntryPath: entryPath,
			EntryName: entryName,
			Holder:    holder,
			Number:    num,
			ExpMonth:  m,
			ExpYear:   y,
			CVV:       cvv,
			Brand:     brand,
		})
	}
	return results
}
