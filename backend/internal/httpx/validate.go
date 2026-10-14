package httpx

import (
	"strings"
	"unicode"
)

func trimASCII(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r <= unicode.MaxASCII && unicode.IsSpace(r)
	})
}

func validUsername(s string) bool {
	if l := len(s); l < 3 || l > 64 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}
