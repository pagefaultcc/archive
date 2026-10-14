package auth

import (
	"strings"
	"testing"
)

const validPHC = "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$kJDfvXaMXKNdsD5OvUQnX7u4YYF0kStITiL8rB3fVBA"

func TestHashRoundTrip(t *testing.T) {
	h, err := Hash([]byte("correct horse"), DefaultParams)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	ok, err := Verify([]byte("correct horse"), h)
	if err != nil || !ok {
		t.Fatalf("Verify correct: ok=%v err=%v", ok, err)
	}
	ok, err = Verify([]byte("wrong"), h)
	if err != nil || ok {
		t.Fatalf("Verify wrong: ok=%v err=%v", ok, err)
	}
}

func TestIndependentSalts(t *testing.T) {
	a, _ := Hash([]byte("same"), DefaultParams)
	b, _ := Hash([]byte("same"), DefaultParams)
	if a == b {
		t.Fatal("identical hashes for same password: salts not random")
	}
}

func TestCanonicalFormat(t *testing.T) {
	h, _ := Hash([]byte("x"), DefaultParams)
	parts := strings.Split(h, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" {
		t.Fatalf("bad field structure: %q", h)
	}
	if parts[3] != "m=65536,t=3,p=2" {
		t.Fatalf("bad params: %q", parts[3])
	}
	if strings.ContainsAny(parts[4], "=+/") == strings.Contains(parts[4], "=") && strings.Contains(parts[4], "=") {
		t.Fatalf("salt is padded: %q", parts[4])
	}
}

func TestParseValid(t *testing.T) {
	salt, hash, err := Parse(validPHC)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(salt) != 16 || len(hash) != 32 {
		t.Fatalf("bad lengths salt=%d hash=%d", len(salt), len(hash))
	}
}

func TestParseMalformed(t *testing.T) {
	cases := map[string]string{
		"wrong algorithm":    "$argon2i$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"wrong version":      "$argon2id$v=16$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"missing field":      "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA",
		"empty prefix text":  "argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"param order":        "$argon2id$v=19$t=3,m=65536,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"duplicate param":    "$argon2id$v=19$m=65536,t=3,m=65536,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"unknown param":      "$argon2id$v=19$m=65536,t=3,p=2,x=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"padded salt":        "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"short salt":         "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"long hash":          "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"non-decimal":        "$argon2id$v=19$m=655x6,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"negative memory":    "$argon2id$v=19$m=-1,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"overflow memory":    "$argon2id$v=19$m=99999999999999999999,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"missing value":      "$argon2id$v=19$m=,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"trailing garbage":   "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$",
		"too many fields":    "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$x",
		"v missing":          "$argon2id$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"memory below bound": "$argon2id$v=19$m=8191,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"memory above bound": "$argon2id$v=19$m=131073,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"time zero":          "$argon2id$v=19$m=65536,t=0,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"time above bound":   "$argon2id$v=19$m=65536,t=6,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"threads zero":       "$argon2id$v=19$m=65536,t=3,p=0$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"threads above":      "$argon2id$v=19$m=65536,t=3,p=9$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"empty":              "",
	}
	for name, phc := range cases {
		if _, _, err := Parse(phc); err == nil {
			t.Errorf("%s: expected error, got nil", name)
		}
	}
}

func TestParsePolicyBoundariesAccepted(t *testing.T) {
	for _, params := range []string{
		"m=8192,t=1,p=1", "m=131072,t=5,p=8",
	} {
		phc := "$argon2id$v=19$" + params + "$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
		if _, _, err := Parse(phc); err != nil {
			t.Errorf("%s: unexpected error %v", params, err)
		}
	}
}

func TestVerifyMalformedNoPanic(t *testing.T) {
	for _, phc := range []string{"", "$$", "not-a-hash", validPHC[:len(validPHC)-3]} {
		_, _ = Verify([]byte("x"), phc) // must not panic; error is fine
	}
}

func TestVerifyWrongPassword(t *testing.T) {
	ok, err := Verify([]byte("wrong"), validPHC)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatal("wrong password verified")
	}
}
