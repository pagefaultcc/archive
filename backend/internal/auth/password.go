package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	memMin = 8 * 1024
	memMax = 128 * 1024
	// memoryKiB / timeIterations / parallelism / saltLen / hashLen.
	saltLen = 16
	hashLen = 32

	minMemoryKiB = 8192
	maxMemoryKiB = 131072
	minTime      = 1
	maxTime      = 5
	minThreads   = 1
	maxThreads   = 8
)

// Errors surfaced by parsing and verification.
var (
	ErrMalformed  = errors.New("malformed argon2 PHC string")
	ErrPolicyViol = errors.New("argon2 parameters violate policy")
)

// Params are the canonical parameters used for hashing.
type Params struct {
	MemoryKiB uint32
	Time      uint32
	Threads   uint8
}

// DefaultParams matches the plan: m=65536,t=3,p=2.
var DefaultParams = Params{MemoryKiB: 65536, Time: 3, Threads: 2}

// Hash derives an Argon2id hash with a fresh cryptographic salt and returns
// the canonical PHC string
// $argon2id$v=19$m=<m>,t=<t>,p=<p>$<salt>$<hash>.
func Hash(password []byte, p Params) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generating salt: %w", err)
	}
	key := argon2.IDKey(password, salt, p.Time, p.MemoryKiB, p.Threads, hashLen)
	return encode(DefaultParams, salt, key), nil
}

func encode(p Params, salt, key []byte) string {
	saltB64 := base64.RawStdEncoding.EncodeToString(salt)
	keyB64 := base64.RawStdEncoding.EncodeToString(key)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", p.MemoryKiB, p.Time, p.Threads, saltB64, keyB64)
}

// Parse validates the exact PHC grammar and policy bounds, returning the
// decoded salt and hash.
func Parse(phc string) (salt, hash []byte, err error) {
	parts := strings.Split(phc, "$")
	// Empty prefix yields a leading empty element: "", "argon2id", "v=19", "m=..", salt, hash.
	if len(parts) != 6 || parts[0] != "" {
		return nil, nil, fmt.Errorf("%w: expected 6 $-separated fields", ErrMalformed)
	}
	if parts[1] != "argon2id" {
		return nil, nil, fmt.Errorf("%w: algorithm must be argon2id", ErrMalformed)
	}
	if parts[2] != "v=19" {
		return nil, nil, fmt.Errorf("%w: version field must be exactly v=19", ErrMalformed)
	}
	p, err := parseParams(parts[3])
	if err != nil {
		return nil, nil, err
	}
	if p.MemoryKiB < minMemoryKiB || p.MemoryKiB > maxMemoryKiB {
		return nil, nil, fmt.Errorf("%w: memory out of range", ErrPolicyViol)
	}
	if p.Time < minTime || p.Time > maxTime {
		return nil, nil, fmt.Errorf("%w: iterations out of range", ErrPolicyViol)
	}
	if p.Threads < minThreads || p.Threads > maxThreads {
		return nil, nil, fmt.Errorf("%w: parallelism out of range", ErrPolicyViol)
	}
	salt, err = decodeField(parts[4], saltLen)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: salt: %s", ErrMalformed, err)
	}
	hash, err = decodeField(parts[5], hashLen)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: hash: %s", ErrMalformed, err)
	}
	return salt, hash, nil
}

func parseParams(field string) (Params, error) {
	segments := strings.Split(field, ",")
	if len(segments) != 3 {
		return Params{}, fmt.Errorf("%w: parameters must be m,t,p", ErrMalformed)
	}
	var p Params
	for i, seg := range segments {
		kv := strings.SplitN(seg, "=", 2)
		if len(kv) != 2 {
			return Params{}, fmt.Errorf("%w: parameter %q lacks value", ErrMalformed, seg)
		}
		// Canonical order and no duplicates/unknowns.
		want := []string{"m", "t", "p"}[i]
		if kv[0] != want {
			return Params{}, fmt.Errorf("%w: expected %s=, got %s=", ErrMalformed, want, kv[0])
		}
		if kv[1] == "" || len(kv[1]) > 20 {
			return Params{}, fmt.Errorf("%w: bad decimal %q", ErrMalformed, kv[1])
		}
		for _, c := range kv[1] {
			if c < '0' || c > '9' {
				return Params{}, fmt.Errorf("%w: non-decimal %q", ErrMalformed, kv[1])
			}
		}
		v, err := strconv.ParseUint(kv[1], 10, 64)
		if err != nil {
			return Params{}, fmt.Errorf("%w: value %q overflows", ErrMalformed, kv[1])
		}
		if v > 0xFFFFFFFF {
			return Params{}, fmt.Errorf("%w: value %q exceeds uint32", ErrMalformed, kv[1])
		}
		switch i {
		case 0:
			p.MemoryKiB = uint32(v)
		case 1:
			p.Time = uint32(v)
		case 2:
			if v > 255 {
				return Params{}, fmt.Errorf("%w: parallelism %q exceeds uint8", ErrMalformed, kv[1])
			}
			p.Threads = uint8(v)
		}
	}
	return p, nil
}

func decodeField(s string, want int) ([]byte, error) {
	// Reject padded base64 explicitly.
	if strings.ContainsRune(s, '=') {
		return nil, errors.New("padded base64 not accepted")
	}
	b, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(b) != want {
		return nil, fmt.Errorf("decoded length %d, want %d", len(b), want)
	}
	return b, nil
}

// Verify re-derives the stored hash against the candidate password and
// compares in constant time. Malformed stored values return an error.
func Verify(password []byte, phc string) (bool, error) {
	salt, want, err := Parse(phc)
	if err != nil {
		return false, err
	}
	// Re-parse params (bounded by policy already).
	parts := strings.Split(phc, "$")
	p, err := parseParams(parts[3])
	if err != nil {
		return false, err
	}
	got := argon2.IDKey(password, salt, p.Time, p.MemoryKiB, p.Threads, hashLen)
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
