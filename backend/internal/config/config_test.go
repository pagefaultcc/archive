package config

import "testing"

func TestParseOriginValid(t *testing.T) {
	for _, raw := range []string{"http://localhost:3000", "https://archive.example.com", "http://10.0.0.1:3000"} {
		if _, err := ParseOrigin(raw); err != nil {
			t.Errorf("%s: %v", raw, err)
		}
	}
}

func TestParseOriginInvalid(t *testing.T) {
	for _, raw := range []string{
		"", "ftp://x", "localhost:3000", "http://", "http://h/path", "http://h?q=1",
		"http://h#f", "http://user:pass@h", "//h", "http://h/path?a=b#f",
	} {
		if _, err := ParseOrigin(raw); err == nil {
			t.Errorf("%q: expected error", raw)
		}
	}
}

func TestOriginMatches(t *testing.T) {
	base := MustParseOriginURL("http://localhost:3000")
	if !base.Matches(MustParseOriginURL("http://localhost:3000")) {
		t.Error("identical origin must match")
	}
	if base.Matches(MustParseOriginURL("http://localhost:3001")) {
		t.Error("different port must not match")
	}
	if base.Matches(MustParseOriginURL("https://localhost:3000")) {
		t.Error("different scheme must not match")
	}
	if base.Matches(MustParseOriginURL("http://evil.example")) {
		t.Error("different host must not match")
	}
	// Effective port: default 80 http and 443 https.
	http80 := MustParseOriginURL("http://h")
	if !http80.Matches(MustParseOriginURL("http://h:80")) {
		t.Error("implicit port 80 must match explicit")
	}
	https443 := MustParseOriginURL("https://h")
	if !https443.Matches(MustParseOriginURL("https://h:443")) {
		t.Error("implicit port 443 must match explicit")
	}
}

func TestLoadMissingVariables(t *testing.T) {
	if _, err := Load(); err == nil {
		t.Fatal("expected error with empty env")
	}
}
