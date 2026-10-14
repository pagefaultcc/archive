package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Config carries process configuration from the environment.
type Config struct {
	DatabaseURL  string
	Addr         string
	PublicOrigin *URL
	RootUsername string
	RootPassword string
}

// Load reads required variables and validates PUBLIC_ORIGIN.
func Load() (Config, error) {
	c := Config{
		DatabaseURL:  os.Getenv("DATABASE_URL"),
		Addr:         ":8080",
		RootUsername: strings.TrimSpace(os.Getenv("ROOT_USERNAME")),
		RootPassword: os.Getenv("ROOT_PASSWORD"),
	}
	if a := os.Getenv("ADDR"); a != "" {
		c.Addr = a
	}
	if c.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	origin := os.Getenv("PUBLIC_ORIGIN")
	if origin == "" {
		return Config{}, errors.New("PUBLIC_ORIGIN is required")
	}
	u, err := ParseOriginURL(origin)
	if err != nil {
		return Config{}, fmt.Errorf("PUBLIC_ORIGIN: %w", err)
	}
	c.PublicOrigin = u
	return c, nil
}

// ParseOrigin requires one absolute HTTP(S) origin with no path, query,
// fragment, or user info.
func ParseOrigin(origin string) (*url.URL, error) {
	u, err := url.Parse(origin)
	if err != nil {
		return nil, errors.New("must be an absolute URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("scheme must be http or https")
	}
	if u.Host == "" {
		return nil, errors.New("host is required")
	}
	if u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" || u.RawFragment != "" || u.Opaque != "" || u.User != nil {
		return nil, errors.New("must be a bare origin without path, query, fragment, or user info")
	}
	return u, nil
}

// URL wraps a parsed origin URL with matching logic.
type URL struct{ *url.URL }

// ParseOriginURL parses and validates a candidate origin.
func ParseOriginURL(raw string) (*URL, error) {
	u, err := ParseOrigin(raw)
	if err != nil {
		return nil, err
	}
	return &URL{URL: u}, nil
}

// MustParseOriginURL panics on invalid input; for tests.
func MustParseOriginURL(raw string) *URL {
	u, err := ParseOriginURL(raw)
	if err != nil {
		panic(err)
	}
	return u
}

// Matches compares against another origin.
func (u *URL) Matches(other *URL) bool { return OriginMatches(u.URL, other.URL) }

// OriginMatches compares a request Origin URL against the configured origin
// by normalized scheme, hostname, and effective port.
func OriginMatches(configured, origin *url.URL) bool {
	if configured == nil || origin == nil {
		return false
	}
	if configured.Scheme != origin.Scheme {
		return false
	}
	ch, oh := canonicalHost(configured.Host), canonicalHost(origin.Host)
	if ch == "" || oh == "" {
		return false
	}
	if ch != oh && !(isLoopbackHost(ch) && isLoopbackHost(oh)) {
		return false
	}
	return effectivePort(configured) == effectivePort(origin)
}

func isLoopbackHost(h string) bool {
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

func canonicalHost(hostport string) string {
	host := hostport
	if h, _, found := strings.Cut(hostport, ":"); found {
		host = h
	}
	return strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
}

func effectivePort(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}
