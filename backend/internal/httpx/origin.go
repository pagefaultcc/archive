package httpx

import (
	"net/http"
	"net/url"

	"archive/backend/internal/config"
)

// RequireOrigin enforces a valid same-origin request matching PUBLIC_ORIGIN on
// every unsafe method, including login and logout.
func RequireOrigin(origin *config.URL, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		values := r.Header.Values("Origin")
		if len(values) == 1 && values[0] != "" && values[0] != "null" {
			u, err := config.ParseOriginURL(values[0])
			if err != nil || !origin.Matches(u) {
				WriteError(w, Forbidden)
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if len(values) == 0 || (len(values) == 1 && values[0] == "null") {
			if ref := r.Header.Get("Referer"); ref != "" {
				if ru, err := url.Parse(ref); err == nil && ru.Scheme != "" && ru.Host != "" {
					cand := &url.URL{Scheme: ru.Scheme, Host: ru.Host}
					if config.OriginMatches(origin.URL, cand) {
						next.ServeHTTP(w, r)
						return
					}
				}
			}
			if r.Header.Get("Sec-Fetch-Site") == "same-origin" {
				next.ServeHTTP(w, r)
				return
			}
		}
		WriteError(w, Forbidden)
	})
}
