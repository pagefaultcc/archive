package httpx

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"archive/backend/internal/auth"
	"archive/backend/internal/config"
	"archive/backend/internal/store"
)

const (
	sessionCookie   = "archive_session"
	sessionMaxAge   = 604800 // seconds
	dummyVerifyWait = 2 * time.Second
)

// AuthHandlers implements login/logout/me.
type AuthHandlers struct {
	Store    *store.Store
	Limiter  *auth.Limiter
	Origin   *config.URL
	Secure   bool
	Dummy    string // startup-generated dummy Argon2id hash
	Log      *slog.Logger
	TimeNow  func() time.Time
	NewToken func() ([]byte, error)
}

// NewAuthHandlers builds handlers and generates the dummy hash.
func NewAuthHandlers(st *store.Store, lim *auth.Limiter, origin *config.URL, secure bool, log *slog.Logger) *AuthHandlers {
	dummy, err := auth.Hash([]byte("dummy-password-for-unknown-users"), auth.DefaultParams)
	if err != nil {
		// Startup cannot proceed without the dummy hash.
		panic(err)
	}
	return &AuthHandlers{Store: st, Limiter: lim, Origin: origin, Secure: secure, Dummy: dummy, Log: log, TimeNow: time.Now, NewToken: randReadToken}
}

func randReadToken() ([]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	User store.SessionUser `json:"user"`
}

// Login validates input, enforces the two-slot limiter, and issues a session.
func (h *AuthHandlers) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if apiErr := DecodeJSON(r, &req); apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	username := strings.TrimSpace(req.Username)
	if l := len(username); l < 3 || l > 64 {
		WriteError(w, WithFields(map[string]string{"username": "Use 3 to 64 characters."}))
		return
	}
	if l := len(req.Password); l < 1 || l > 128 {
		WriteError(w, WithFields(map[string]string{"password": "Password is required."}))
		return
	}

	ctx := r.Context()
	release, err := h.Limiter.Acquire(ctx, dummyVerifyWait)
	if err != nil {
		if errors.Is(err, auth.ErrBusy) {
			w.Header().Set("Retry-After", "2")
			WriteError(w, AuthenticationBusy)
			return
		}
		WriteError(w, InternalServerError)
		return
	}
	defer release()

	user, found, err := h.Store.UserByUsername(ctx, username)
	if err != nil {
		h.logInternal(ctx, "login lookup failed", err)
		WriteError(w, InternalServerError)
		return
	}
	target := h.Dummy
	if found {
		target = user.PasswordHash
	}
	ok, err := auth.Verify([]byte(req.Password), target)
	if err != nil {
		// Malformed stored value fails authentication without panic.
		h.logInternal(ctx, "password verification failed", err)
		WriteError(w, InvalidCredentials)
		return
	}
	if !found || !ok {
		WriteError(w, InvalidCredentials)
		return
	}
	// Suspended and soft-deleted users can never sign in; the response is
	// byte-identical to invalid credentials so account state does not leak.
	if user.Status != "active" {
		WriteError(w, InvalidCredentials)
		return
	}

	raw, err := h.NewToken()
	if err != nil {
		h.logInternal(ctx, "token generation failed", err)
		WriteError(w, InternalServerError)
		return
	}
	digest := sha256.Sum256(raw)
	now := h.TimeNow().UTC()
	expires := now.Add(sessionMaxAge * time.Second)
	if err := h.Store.CreateSession(ctx, hex.EncodeToString(digest[:]), user.ID, expires); err != nil {
		h.logInternal(ctx, "session persistence failed", err)
		WriteError(w, InternalServerError)
		return
	}

	roles, err := h.Store.RolesFor(ctx, user.ID)
	if err != nil {
		h.logInternal(ctx, "role lookup failed", err)
		WriteError(w, InternalServerError)
		return
	}
	perms, err := h.Store.PermissionsFor(ctx, user.ID)
	if err != nil {
		h.logInternal(ctx, "permission lookup failed", err)
		WriteError(w, InternalServerError)
		return
	}

	h.setCookie(w, base64.RawURLEncoding.EncodeToString(raw), expires)
	WriteJSON(w, http.StatusOK, loginResponse{User: store.SessionUser{
		ID: user.ID, Username: user.Username, IsRoot: user.IsRoot, Roles: roles, Permissions: perms,
	}})
}

// Logout deletes the current session and always clears the cookie.
func (h *AuthHandlers) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
		if digest, ok := digestToken(c.Value); ok {
			if err := h.Store.DeleteSession(r.Context(), digest); err != nil {
				h.logInternal(r.Context(), "logout delete failed", err)
				WriteError(w, InternalServerError)
				return
			}
		}
	}
	h.clearCookie(w)
	WriteNoContent(w)
}

// Me returns the current session identity or 401.
func (h *AuthHandlers) Me(w http.ResponseWriter, r *http.Request) {
	u, ok := SessionFrom(r.Context())
	if !ok {
		h.clearCookie(w)
		WriteError(w, Unauthenticated)
		return
	}
	WriteJSON(w, http.StatusOK, loginResponse{User: *u})
}

// SessionUserFromCookie resolves the cookie to a SessionUser. Invalid,
// unknown, and expired tokens return found=false; database failures remain
// distinct so callers do not clear a valid cookie on infrastructure errors.
func (h *AuthHandlers) SessionUserFromCookie(ctx context.Context, cookie *http.Cookie) (*store.SessionUser, bool, error) {
	if cookie == nil || cookie.Value == "" {
		return nil, false, nil
	}
	digest, ok := digestToken(cookie.Value)
	if !ok {
		return nil, false, nil
	}
	u, found, err := h.Store.SessionUserByDigest(ctx, digest)
	if err != nil {
		return nil, false, err
	}
	if !found {
		// This removes an encountered expired row; deleting an unknown digest is harmless.
		if err := h.Store.DeleteSession(ctx, digest); err != nil {
			return nil, false, err
		}
		return nil, false, nil
	}
	return &u, true, nil
}

func digestToken(rawB64 string) (string, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(rawB64)
	if err != nil || len(raw) != 32 {
		return "", false
	}
	d := sha256.Sum256(raw)
	return hex.EncodeToString(d[:]), true
}

func (h *AuthHandlers) setCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   sessionMaxAge,
		Expires:  expires,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.Secure,
	})
}

func (h *AuthHandlers) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(0, 0).UTC(),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.Secure,
	})
}

type ctxUserKey struct{}

// WithSession stores the SessionUser in the request context.
func WithSession(ctx context.Context, u *store.SessionUser) context.Context {
	return context.WithValue(ctx, ctxUserKey{}, u)
}

// SessionFrom reads the SessionUser from the request context.
func SessionFrom(ctx context.Context) (*store.SessionUser, bool) {
	u, ok := ctx.Value(ctxUserKey{}).(*store.SessionUser)
	return u, ok
}

// SessionMiddleware loads the session, and clears the cookie when it is
// malformed, unknown, or expired.
func (h *AuthHandlers) SessionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookie)
		if err != nil || cookie.Value == "" {
			next.ServeHTTP(w, r)
			return
		}
		u, ok, loadErr := h.SessionUserFromCookie(r.Context(), cookie)
		if loadErr != nil {
			h.logInternal(r.Context(), "session lookup failed", loadErr)
			WriteError(w, InternalServerError)
			return
		}
		if !ok {
			h.clearCookie(w)
			next.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithSession(r.Context(), u)))
	})
}

// RequirePermission checks a named permission via role joins before any
// protected body decode or data query. is_root never bypasses.
func (h *AuthHandlers) RequirePermission(permission string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := SessionFrom(r.Context())
		if !ok {
			WriteError(w, Unauthenticated)
			return
		}
		has, err := h.Store.HasPermission(r.Context(), u.ID, permission)
		if err != nil {
			h.logInternal(r.Context(), "permission check failed", err)
			WriteError(w, InternalServerError)
			return
		}
		if !has {
			WriteError(w, Forbidden)
			return
		}
		next(w, r)
	}
}

func (h *AuthHandlers) logInternal(ctx context.Context, msg string, err error) {
	h.Log.Error(msg, "request_id", RequestID(ctx), "error", err.Error())
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// ChangePassword handles POST /api/auth/change-password.
func (h *AuthHandlers) ChangePassword(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if actor == nil {
		WriteError(w, Unauthenticated)
		return
	}
	var req changePasswordRequest
	if err := DecodeJSON(r, &req); err != nil {
		WriteError(w, err)
		return
	}
	if req.CurrentPassword == "" {
		WriteError(w, WithFields(map[string]string{"currentPassword": "Current password is required."}))
		return
	}
	if len(req.NewPassword) < 8 || len(req.NewPassword) > 128 {
		WriteError(w, WithFields(map[string]string{"newPassword": "New password must be between 8 and 128 characters."}))
		return
	}

	// 1. Verify current password
	hash, err := h.Store.GetUserPasswordHash(r.Context(), actor.ID)
	if err != nil {
		h.logInternal(r.Context(), "loading user password hash failed", err)
		WriteError(w, InternalServerError)
		return
	}
	ok, err := auth.Verify([]byte(req.CurrentPassword), hash)
	if err != nil || !ok {
		WriteError(w, WithFields(map[string]string{"currentPassword": "Incorrect current password."}))
		return
	}

	// 2. Hash new password
	newHash, err := auth.Hash([]byte(req.NewPassword), auth.DefaultParams)
	if err != nil {
		h.logInternal(r.Context(), "hashing new password failed", err)
		WriteError(w, InternalServerError)
		return
	}

	// 3. Update database
	if err := h.Store.ChangeOwnPassword(r.Context(), actor.ID, newHash); err != nil {
		h.logInternal(r.Context(), "updating password failed", err)
		WriteError(w, InternalServerError)
		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"message": "Password changed successfully.",
	})
}

// constantTimeEqual preserves constant-time comparison for token digests.
var _ = subtle.ConstantTimeCompare
