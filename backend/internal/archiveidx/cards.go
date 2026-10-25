package archiveidx

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf16"

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
						"-ir!*cards.txt*", "-ir!*card.txt*",
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

// isCandidateCardFile reports whether an entry is Cards.txt or Card.txt.
func isCandidateCardFile(entryPath, entryName string, size int64) bool {
	if size <= 0 || size > 15*1024*1024 {
		return false
	}
	ln := strings.ToLower(entryName)
	if strings.HasPrefix(ln, "._") {
		return false
	}
	return ln == "cards.txt" || ln == "card.txt"
}

// decodeUTF16 decodes UTF-16 bytes into a UTF-8 string.
func decodeUTF16(b []byte, littleEndian bool) string {
	if len(b)%2 != 0 {
		b = b[:len(b)-1]
	}
	u16 := make([]uint16, len(b)/2)
	for i := range u16 {
		if littleEndian {
			u16[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
		} else {
			u16[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
		}
	}
	return string(utf16.Decode(u16))
}

// normalizeLogText detects UTF-16, UTF-8 BOM, or null-byte pollution and returns clean UTF-8 text.
func normalizeLogText(raw []byte) string {
	if len(raw) >= 2 && raw[0] == 0xff && raw[1] == 0xfe {
		return decodeUTF16(raw[2:], true)
	}
	if len(raw) >= 2 && raw[0] == 0xfe && raw[1] == 0xff {
		return decodeUTF16(raw[2:], false)
	}
	raw = bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})
	if len(raw) >= 4 && raw[1] == 0 && raw[3] == 0 {
		return decodeUTF16(raw, true)
	}
	if bytes.IndexByte(raw, 0) >= 0 {
		raw = bytes.ReplaceAll(raw, []byte{0}, []byte{})
	}
	return strings.ToValidUTF8(string(raw), "")
}

// hasCardSignatures is a quick check to reject binary/irrelevant blobs.
func hasCardSignatures(raw []byte) bool {
	if len(raw) < 12 {
		return false
	}
	if bytes.HasPrefix(raw, []byte("SQLite format 3\x00")) {
		return false
	}
	head := raw
	if len(head) > 4096 {
		head = head[:4096]
	}
	normHead := normalizeLogText(head)
	trimmed := strings.TrimSpace(normHead)
	if len(trimmed) < 12 {
		return false
	}
	for _, r := range trimmed {
		if r >= '0' && r <= '9' {
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
			if len(parts) == 2 {
				mStr := cleanCardDigits(strings.TrimSpace(parts[0]))
				yStr := cleanCardDigits(strings.TrimSpace(parts[1]))
				if mStr == "" || yStr == "" {
					return "", ""
				}
				m, errM := strconv.Atoi(mStr)
				y, errY := strconv.Atoi(yStr)
				if errM != nil || errY != nil || m < 1 || m > 12 {
					return "", ""
				}
				if y < 100 {
					y += 2000
				}
				// Valid expiration year must be between 2024 and 2045
				if y < 2024 || y > 2045 {
					return "", ""
				}
				return fmt.Sprintf("%02d", m), strconv.Itoa(y)
			}
			return "", ""
		}
	}
	// 4 digits: MMYY
	digits := cleanCardDigits(exp)
	if len(digits) == 4 {
		m, errM := strconv.Atoi(digits[:2])
		y, errY := strconv.Atoi(digits[2:])
		if errM == nil && errY == nil && m >= 1 && m <= 12 {
			y += 2000
			if y >= 2024 && y <= 2045 {
				return fmt.Sprintf("%02d", m), strconv.Itoa(y)
			}
		}
	}
	if len(digits) == 6 {
		m, errM := strconv.Atoi(digits[:2])
		y, errY := strconv.Atoi(digits[2:])
		if errM == nil && errY == nil && m >= 1 && m <= 12 && y >= 2024 && y <= 2045 {
			return fmt.Sprintf("%02d", m), strconv.Itoa(y)
		}
	}
	return "", ""
}

// parseCardFileBytes handles key-value blocks, delimited rows, and JSON dumps.
func parseCardFileBytes(entryPath, entryName string, raw []byte) []CardChunk {
	text := normalizeLogText(raw)
	trimmed := strings.TrimSpace(text)
	if len(trimmed) == 0 {
		return nil
	}

	// JSON format check
	if (trimmed[0] == '[' || trimmed[0] == '{') && json.Valid([]byte(trimmed)) {
		if chunks := parseJSONCards(entryPath, entryName, []byte(trimmed)); len(chunks) > 0 {
			return chunks
		}
	}

	lines := strings.Split(text, "\n")

	var result []CardChunk
	seenNumbers := make(map[string]bool)
	var curHolder, curNumber, curExpMonth, curExpYear, curCVV, curBrand string

	emitCurrent := func() {
		digits := cleanCardDigits(curNumber)
		cvvDigits := cleanCardDigits(curCVV)
		if len(digits) >= 13 && len(digits) <= 19 && checkLuhn(digits) {
			// Strictly require BOTH valid expiration AND valid CVV (3 or 4 digits)
			if curExpMonth != "" && curExpYear != "" && (len(cvvDigits) == 3 || len(cvvDigits) == 4) {
				brand := curBrand
				if brand == "" || strings.EqualFold(brand, "unknown") {
					brand = DetectCardBrand(digits)
				}
				if !seenNumbers[digits] {
					seenNumbers[digits] = true
					result = append(result, CardChunk{
						EntryPath: entryPath,
						EntryName: entryName,
						Holder:    curHolder,
						Number:    digits,
						ExpMonth:  curExpMonth,
						ExpYear:   curExpYear,
						CVV:       cvvDigits,
						Brand:     brand,
					})
				}
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
		// Separator lines (ASCII and Unicode box drawing ═, ─) or Card headers (without colons)
		if strings.HasPrefix(line, "===") || strings.HasPrefix(line, "---") || strings.HasPrefix(line, "***") ||
			strings.HasPrefix(line, "═══") || strings.HasPrefix(line, "───") || strings.HasPrefix(line, "___") ||
			((strings.HasPrefix(line, "Card ") || strings.HasPrefix(line, "card ")) && strings.IndexByte(line, ':') < 0) {
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

	if cardNumber == "" || !checkLuhn(cardNumber) || expMonth == "" || expYear == "" || (len(cvv) != 3 && len(cvv) != 4) {
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
		if len(num) < 13 || len(num) > 19 || !checkLuhn(num) {
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
		if m == "" || y == "" || (len(cvv) != 3 && len(cvv) != 4) {
			continue
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
