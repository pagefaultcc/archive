package archiveidx

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeRootDomain(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		// Standard domains
		{"google.com", "google.com"},
		{".google.com", "google.com"},
		{"..google.com..", "google.com"},
		{"chatgpt.com", "chatgpt.com"},
		{"chat.openai.com", "openai.com"},
		{"api.auth.openai.com", "openai.com"},
		{"sub.deep.level.example.org", "example.org"},

		// URLs with schemes, paths, ports
		{"https://chatgpt.com/auth/login", "chatgpt.com"},
		{"http://sub.example.com:8080/foo", "example.com"},
		{"https://accounts.google.com:443", "google.com"},

		// Multi-part ccTLDs
		{"bbc.co.uk", "bbc.co.uk"},
		{"news.bbc.co.uk", "bbc.co.uk"},
		{"mercadolivre.com.br", "mercadolivre.com.br"},
		{"sub.mercadolivre.com.br", "mercadolivre.com.br"},
		{"afip.gob.ar", "afip.gob.ar"},
		{"amazon.co.jp", "amazon.co.jp"},
		{"sub.yahoo.co.kr", "yahoo.co.kr"},
		{"ebay.com.au", "ebay.com.au"},
		{"police.gob.pe", "police.gob.pe"},
		{"sub.bank.co.za", "bank.co.za"},
		{"sub.portal.gov.tr", "portal.gov.tr"},
		{"sub.yandex.com.ru", "yandex.com.ru"},

		// IP addresses (must preserve exact IP, not last two octets)
		{"192.168.1.1", "192.168.1.1"},
		{"85.9.208.82", "85.9.208.82"},
		{"http://127.0.0.1:3000/foo", "127.0.0.1"},
		{"::1", "::1"},

		// BOM and whitespace
		{"\ufeffchatgpt.com", "chatgpt.com"},
		{"   .openai.com   ", "openai.com"},
		{"\ufeff.google.com", "google.com"},

		// Invalid or single-word hosts
		{"localhost", ""},
		{"internal", ""},
		{"", ""},
		{"...", ""},
	}

	for _, tt := range tests {
		got := NormalizeRootDomain(tt.input)
		if got != tt.want {
			t.Errorf("NormalizeRootDomain(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestParseCookieFileBytes_Netscape(t *testing.T) {
	// 1. Standard 7-column Netscape
	t.Run("Standard Netscape", func(t *testing.T) {
		raw := []byte(".google.com\tTRUE\t/\tTRUE\t1822690705\tSSID\tAoVQCg0KXGx1W0t5b\n")
		chunks := parseCookieFileBytes("Cookies/Chrome_0.txt", "Chrome_0.txt", raw)
		if len(chunks) != 1 {
			t.Fatalf("expected 1 chunk, got %d", len(chunks))
		}
		if chunks[0].Domain != "google.com" {
			t.Errorf("expected domain google.com, got %s", chunks[0].Domain)
		}
		if chunks[0].CookieCount != 1 {
			t.Errorf("expected 1 cookie, got %d", chunks[0].CookieCount)
		}
	})

	// 2. Case-insensitive #HttpOnly_ prefixes
	t.Run("HttpOnly prefixes", func(t *testing.T) {
		raw := []byte(
			"#HttpOnly_.chatgpt.com\tTRUE\t/\tTRUE\t1797384732\toai-did\tde9fce2f-b6c5\n" +
				"#HTTPONLY_.chatgpt.com\tTRUE\t/\tTRUE\t1797384732\t__Secure-next-auth\tsome_token\n" +
				"#httponly_.chatgpt.com\tTRUE\t/\tTRUE\t1797384732\toai-sc\t0gAAAAAB\n",
		)
		chunks := parseCookieFileBytes("Cookies/Chrome.txt", "Chrome.txt", raw)
		if len(chunks) != 1 {
			t.Fatalf("expected 1 chunk, got %d", len(chunks))
		}
		if chunks[0].CookieCount != 3 {
			t.Errorf("expected 3 cookies parsed from #HttpOnly_ variations, got %d", chunks[0].CookieCount)
		}
	})

	// 3. UTF-8 BOM at start of file
	t.Run("UTF-8 BOM", func(t *testing.T) {
		raw := append([]byte("\xef\xbb\xbf"), []byte(".chatgpt.com\tTRUE\t/\tTRUE\t1797384732\ttoken\txyz123\n")...)
		chunks := parseCookieFileBytes("Cookies/Chrome.txt", "Chrome.txt", raw)
		if len(chunks) != 1 {
			t.Fatalf("expected 1 chunk, got %d", len(chunks))
		}
		if chunks[0].Domain != "chatgpt.com" {
			t.Errorf("expected domain chatgpt.com without BOM, got %q", chunks[0].Domain)
		}
	})

	// 4. Windows CRLF and classic Mac CR line endings
	t.Run("Diverse line endings", func(t *testing.T) {
		raw := []byte(".site1.com\tTRUE\t/\tTRUE\t1800000000\ta\t1\r\n.site2.com\tTRUE\t/\tTRUE\t1800000000\tb\t2\r.site3.com\tTRUE\t/\tTRUE\t1800000000\tc\t3\n")
		chunks := parseCookieFileBytes("c.txt", "c.txt", raw)
		if len(chunks) != 3 {
			t.Fatalf("expected 3 domain chunks across CRLF/CR/LF, got %d", len(chunks))
		}
	})

	// 5. 6-column line (empty value without trailing tab) and empty value with trailing tab
	t.Run("Empty cookie values", func(t *testing.T) {
		raw := []byte(
			".example.com\tTRUE\t/\tFALSE\t0\tempty_no_tab\n" +
				".example.com\tTRUE\t/\tFALSE\t0\tempty_with_tab\t\n",
		)
		chunks := parseCookieFileBytes("c.txt", "c.txt", raw)
		if len(chunks) != 1 || chunks[0].CookieCount != 2 {
			t.Fatalf("expected 2 cookies with empty values, got %+v", chunks)
		}
		lines := strings.Split(chunks[0].NetscapeText, "\n")
		if len(lines) != 2 {
			t.Fatalf("expected 2 Netscape lines, got %d", len(lines))
		}
	})

	// 6. Float expiration timestamps (e.g. 1712345678.99) and session cookies (0 or string)
	t.Run("Float and session expiry", func(t *testing.T) {
		raw := []byte(
			".example.com\tTRUE\t/\tFALSE\t1712345678.99\tfloat_exp\tval1\n" +
				".example.com\tTRUE\t/\tFALSE\t0\tsession_0\tval2\n" +
				".example.com\tTRUE\t/\tFALSE\tNone\tsession_none\tval3\n",
		)
		chunks := parseCookieFileBytes("c.txt", "c.txt", raw)
		if len(chunks) != 1 || chunks[0].CookieCount != 3 {
			t.Fatalf("expected 3 cookies including float & session exp, got %+v", chunks)
		}
	})

	// 7. Numeric booleans (1 and 0 for flags)
	t.Run("Numeric boolean flags", func(t *testing.T) {
		raw := []byte(".example.com\t1\t/\t0\t1700000000\tnum_flag\tval\n")
		chunks := parseCookieFileBytes("c.txt", "c.txt", raw)
		if len(chunks) != 1 || chunks[0].CookieCount != 1 {
			t.Fatalf("expected 1 cookie with numeric flags, got %+v", chunks)
		}
	})

	// 8. Value containing embedded tabs or equal signs
	t.Run("Embedded tabs and special chars in value", func(t *testing.T) {
		raw := []byte(".example.com\tTRUE\t/\tTRUE\t1700000000\tcomplex_val\tpart1\tpart2=xyz==\tpart3\n")
		chunks := parseCookieFileBytes("c.txt", "c.txt", raw)
		if len(chunks) != 1 {
			t.Fatalf("expected 1 chunk, got %d", len(chunks))
		}
		var jc []JSONCookie
		if err := json.Unmarshal([]byte(chunks[0].JSONText), &jc); err != nil {
			t.Fatalf("json unmarshal failed: %v", err)
		}
		if jc[0].Value != "part1\tpart2=xyz==\tpart3" {
			t.Errorf("expected value to retain embedded tabs and symbols, got %q", jc[0].Value)
		}
	})

	// 9. Comments and malformed lines ignored without breaking valid lines
	t.Run("Comments and garbage lines", func(t *testing.T) {
		raw := []byte(
			"# Netscape HTTP Cookie File\n" +
				"# Generated by Stealer Tool v3.2\n" +
				"\n" +
				"garbage line without tabs\n" +
				".valid.com\tTRUE\t/\tTRUE\t1700000000\tvalid_cookie\tgood\n" +
				"# another comment\n",
		)
		chunks := parseCookieFileBytes("c.txt", "c.txt", raw)
		if len(chunks) != 1 || chunks[0].CookieCount != 1 {
			t.Fatalf("expected 1 valid cookie ignoring comments and garbage, got %+v", chunks)
		}
	})
}

func TestParseCookieFileBytes_JSON(t *testing.T) {
	// 1. Standard array format (EditThisCookie / J2Team)
	t.Run("Standard JSON Array", func(t *testing.T) {
		raw := []byte(`[
			{
				"domain": ".chatgpt.com",
				"name": "oai-did",
				"value": "de9fce2f",
				"path": "/",
				"secure": true,
				"expirationDate": 1797384732
			},
			{
				"domain": "chatgpt.com",
				"name": "__cf_bm",
				"value": "bm123",
				"path": "/",
				"secure": false,
				"expirationDate": 1797384732.5
			}
		]`)
		chunks := parseCookieFileBytes("cookies.json", "cookies.json", raw)
		if len(chunks) != 1 {
			t.Fatalf("expected 1 chunk for chatgpt.com, got %d", len(chunks))
		}
		if chunks[0].CookieCount != 2 {
			t.Errorf("expected 2 cookies, got %d", chunks[0].CookieCount)
		}
	})

	// 2. Object wrapper format {"cookies": [...]} and {"data": [...]}
	t.Run("Object Wrapper JSON", func(t *testing.T) {
		raw := []byte(`{
			"cookies": [
				{
					"host": "github.com",
					"name": "user_session",
					"value": "gh_sess_999",
					"secure": "true",
					"expirationDate": "1800000000"
				}
			]
		}`)
		chunks := parseCookieFileBytes("cookies.json", "cookies.json", raw)
		if len(chunks) != 1 || chunks[0].Domain != "github.com" {
			t.Fatalf("expected 1 chunk for github.com, got %+v", chunks)
		}
	})

	// 3. Alternative key names (host, Domain, key, Name, Value, expiry)
	t.Run("Alternative JSON Key Names", func(t *testing.T) {
		raw := []byte(`[
			{
				"host": ".openai.com",
				"key": "auth_token",
				"Value": "token_val",
				"Path": "/auth",
				"secure": 1,
				"expiry": 1850000000
			}
		]`)
		chunks := parseCookieFileBytes("cookies.json", "cookies.json", raw)
		if len(chunks) != 1 || chunks[0].Domain != "openai.com" {
			t.Fatalf("expected 1 chunk for openai.com, got %+v", chunks)
		}
		if chunks[0].CookieCount != 1 {
			t.Errorf("expected 1 cookie, got %d", chunks[0].CookieCount)
		}
	})

	// 4. Single JSON cookie object
	t.Run("Single JSON Object", func(t *testing.T) {
		raw := []byte(`{
			"domain": ".twitter.com",
			"name": "auth_token",
			"value": "tw_12345",
			"path": "/",
			"secure": true
		}`)
		chunks := parseCookieFileBytes("single.json", "single.json", raw)
		if len(chunks) != 1 || chunks[0].Domain != "twitter.com" {
			t.Fatalf("expected 1 chunk for twitter.com, got %+v", chunks)
		}
	})
}

func TestParseCookieFileBytes_MultiDomainSplitting(t *testing.T) {
	raw := []byte(
		".google.com\tTRUE\t/\tTRUE\t1800000000\tSID\tgoog1\n" +
			".chatgpt.com\tTRUE\t/\tTRUE\t1800000000\toai\tchat1\n" +
			".google.com\tTRUE\t/\tTRUE\t1800000000\tHSID\tgoog2\n" +
			"sub.github.com\tTRUE\t/\tTRUE\t1800000000\tsess\tgit1\n" +
			".chatgpt.com\tTRUE\t/\tTRUE\t1800000000\tsession\tchat2\n",
	)

	chunks := parseCookieFileBytes("All_Cookies.txt", "All_Cookies.txt", raw)
	if len(chunks) != 3 {
		t.Fatalf("expected 3 separate domain chunks (google.com, chatgpt.com, github.com), got %d", len(chunks))
	}

	chunkMap := make(map[string]DomainCookieChunk)
	for _, c := range chunks {
		chunkMap[c.Domain] = c
	}

	if chunkMap["google.com"].CookieCount != 2 {
		t.Errorf("expected 2 cookies for google.com, got %d", chunkMap["google.com"].CookieCount)
	}
	if chunkMap["chatgpt.com"].CookieCount != 2 {
		t.Errorf("expected 2 cookies for chatgpt.com, got %d", chunkMap["chatgpt.com"].CookieCount)
	}
	if chunkMap["github.com"].CookieCount != 1 {
		t.Errorf("expected 1 cookie for github.com, got %d", chunkMap["github.com"].CookieCount)
	}
}

func TestIsCandidateCookieFile(t *testing.T) {
	// Positive matches
	positives := []struct {
		path, name string
	}{
		{"Cookies/Chrome_0.txt", "Chrome_0.txt"},
		{"User Data/Default/Cookies.txt", "Cookies.txt"},
		{"Browsers/Default.txt", "Default.txt"},
		{"Profile 1/Profile 1.txt", "Profile 1.txt"},
		{"cookies.json", "cookies.json"},
		{"Network/Cookies", "Cookies"},
		{"Logs/192.168.1.1/Google Chrome_Default.txt", "Google Chrome_Default.txt"},
		{"Browsers/EBWebView/Default/Cookies.txt", "Cookies.txt"},
		{"Browsers/Chrome/Default/Cookies.txt", "Cookies.txt"},
		{"url_uniq_cookies.log", "url_uniq_cookies.log"},
		{"Browsers/EBWebView/Default/cookies.log", "cookies.log"},
		{"Browsers/Chrome/Profile 1/cookies.txt", "cookies.txt"},
	}
	for _, p := range positives {
		if !isCandidateCookieFile(p.path, p.name, 1024) {
			t.Errorf("isCandidateCookieFile(%q, %q) = false, want true", p.path, p.name)
		}
	}

	// Negative matches (autofill, passwords, history, non-text files, huge files)
	negatives := []struct {
		path, name string
		size       int64
	}{
		{"Passwords/Chrome_Passwords.txt", "Chrome_Passwords.txt", 1024},
		{"Autofill/Default.txt", "Default.txt", 1024},
		{"History/Chrome_History.txt", "Chrome_History.txt", 1024},
		{"CreditCards/Cards.txt", "Cards.txt", 1024},
		{"Screenshots/desktop.png", "desktop.png", 1024},
		{"Cookies/._Chrome_0.txt", "._Chrome_0.txt", 1024},
		{"Cookies/Chrome_cookie_restore_data_0.txt", "Chrome_cookie_restore_data_0.txt", 1024},
		{"Cookies/Chrome_0.txt", "Chrome_0.txt", 20 * 1024 * 1024}, // > 15MB
	}
	for _, n := range negatives {
		if isCandidateCookieFile(n.path, n.name, n.size) {
			t.Errorf("isCandidateCookieFile(%q, %q, size=%d) = true, want false", n.path, n.name, n.size)
		}
	}
}

func TestHasCookieSignatures(t *testing.T) {
	// 1. Valid Netscape cookie file
	netscapeData := []byte(".google.com\tTRUE\t/\tTRUE\t1795254940\t_GRECAPTCHA\t09AKhCRwjNNRCoBy3rTCq5kKm_OvZyCy7FOgDwAY\n")
	if !hasCookieSignatures(netscapeData) {
		t.Error("hasCookieSignatures(netscapeData) = false, want true")
	}

	// 2. Netscape with HttpOnly prefix
	httpOnlyData := []byte("#HttpOnly_.accounts.google.com\tTRUE\t/\tTRUE\t1795254940\tSSID\tABCD1234\n")
	if !hasCookieSignatures(httpOnlyData) {
		t.Error("hasCookieSignatures(httpOnlyData) = false, want true")
	}

	// 3. Valid JSON cookie array
	jsonData := []byte(`[{"domain": ".openai.com", "name": "session", "value": "xyz", "path": "/"}]`)
	if !hasCookieSignatures(jsonData) {
		t.Error("hasCookieSignatures(jsonData) = false, want true")
	}

	// 4. Non-cookie file: Passwords (no tabs)
	passwordsData := []byte("URL: https://accounts.google.com\nUsername: test@gmail.com\nPassword: mysecretpassword123\n")
	if hasCookieSignatures(passwordsData) {
		t.Error("hasCookieSignatures(passwordsData) = true, want false")
	}

	// 5. Non-cookie log file (no tabs or no cookie structure)
	logData := []byte("2026-10-13 12:00:00 [INFO] System started successfully.\n2026-10-13 12:00:01 [DEBUG] Initializing network modules.\n")
	if hasCookieSignatures(logData) {
		t.Error("hasCookieSignatures(logData) = true, want false")
	}

	// 6. Numeric boolean flags (1/0) and >40 header comment lines
	var headerComments strings.Builder
	for range 60 {
		headerComments.WriteString("# Stealer comment header line\n")
	}
	headerComments.WriteString(".chatgpt.com\t1\t/\t0\t1795254940\t__Secure-next-auth.session-token\txyz\n")
	if !hasCookieSignatures([]byte(headerComments.String())) {
		t.Error("hasCookieSignatures(numeric flags after 60 comment lines) = false, want true")
	}
}
