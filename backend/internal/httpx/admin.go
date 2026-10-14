package httpx

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"archive/backend/internal/auth"
	"archive/backend/internal/store"
)

const auditMaxLimit = 50

type userHandlers struct {
	Store   *store.Store
	Limiter *auth.Limiter
}

type createUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type usersResponse struct {
	Users []store.PublicUser `json:"users"`
}

func (h *userHandlers) list(w http.ResponseWriter, r *http.Request) {
	includeDeleted := r.URL.Query().Get("includeDeleted") == "true"
	users, err := h.Store.ListUsersAll(r.Context(), includeDeleted)
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	if users == nil {
		users = []store.PublicUser{}
	}
	WriteJSON(w, http.StatusOK, usersResponse{Users: users})
}

func (h *userHandlers) get(w http.ResponseWriter, r *http.Request) {
	u, err := h.Store.GetUser(r.Context(), r.PathValue("id"))
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]store.PublicUser{"user": u})
}

func (h *userHandlers) create(w http.ResponseWriter, r *http.Request) {
	// Permission check already happened in RequirePermission; the body is
	// decoded only after authorization.
	var req createUserRequest
	if apiErr := DecodeJSON(r, &req); apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	username := trimASCII(req.Username)
	fields := map[string]string{}
	if !validUsername(username) {
		fields["username"] = "Use 3 to 64 letters, numbers, dots, underscores, or hyphens."
	}
	if l := len(req.Password); l < 12 || l > 128 {
		fields["password"] = "Use 12 to 128 characters."
	}
	if len(fields) > 0 {
		WriteError(w, WithFields(fields))
		return
	}

	hash, apiErr := h.hashWithLimiter(r, req.Password)
	if apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	actor := mustActor(r)
	user, err := h.Store.CreateUser(r.Context(), username, hash, actor.ID)
	if err != nil {
		if err == store.ErrUsernameTaken {
			WriteError(w, UsernameTaken)
			return
		}
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusCreated, map[string]store.PublicUser{"user": user})
}

type updateUsernameRequest struct {
	Username string `json:"username"`
}

func (h *userHandlers) updateUsername(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	var req updateUsernameRequest
	if apiErr := DecodeJSON(r, &req); apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	username := trimASCII(req.Username)
	if !validUsername(username) {
		WriteError(w, WithFields(map[string]string{
			"username": "Use 3 to 64 letters, numbers, dots, underscores, or hyphens.",
		}))
		return
	}
	u, err := h.Store.UpdateUsername(r.Context(), actor.ID, r.PathValue("id"), username)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]store.PublicUser{"user": u})
}

type resetPasswordRequest struct {
	Password string `json:"password"`
}

func (h *userHandlers) resetPassword(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	var req resetPasswordRequest
	if apiErr := DecodeJSON(r, &req); apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	if l := len(req.Password); l < 12 || l > 128 {
		WriteError(w, WithFields(map[string]string{"password": "Use 12 to 128 characters."}))
		return
	}
	hash, apiErr := h.hashWithLimiter(r, req.Password)
	if apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	u, err := h.Store.ResetPassword(r.Context(), actor.ID, r.PathValue("id"), hash)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]store.PublicUser{"user": u})
}

type suspendRequest struct {
	Suspended bool `json:"suspended"`
}

func (h *userHandlers) suspend(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	var req suspendRequest
	if apiErr := DecodeJSON(r, &req); apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	u, err := h.Store.SetSuspended(r.Context(), actor.ID, r.PathValue("id"), req.Suspended)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]store.PublicUser{"user": u})
}

func (h *userHandlers) delete(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if err := h.Store.SoftDeleteUser(r.Context(), actor.ID, r.PathValue("id")); err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteNoContent(w)
}

func (h *userHandlers) restore(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	u, err := h.Store.RestoreUser(r.Context(), actor.ID, r.PathValue("id"))
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]store.PublicUser{"user": u})
}

func (h *userHandlers) listSessions(w http.ResponseWriter, r *http.Request) {
	if _, err := h.Store.GetUser(r.Context(), r.PathValue("id")); err != nil {
		h.writeStoreError(w, err)
		return
	}
	sessions, err := h.Store.ListUserSessions(r.Context(), r.PathValue("id"))
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusOK, map[string][]store.SessionInfo{"sessions": sessions})
}

func (h *userHandlers) revokeSession(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.RevokeSession(r.Context(), r.PathValue("id"), r.PathValue("sid")); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			WriteError(w, NotFound)
			return
		}
		WriteError(w, InternalServerError)
		return
	}
	WriteNoContent(w)
}

func (h *userHandlers) revokeAllSessions(w http.ResponseWriter, r *http.Request) {
	if _, err := h.Store.GetUser(r.Context(), r.PathValue("id")); err != nil {
		h.writeStoreError(w, err)
		return
	}
	if _, err := h.Store.RevokeAllSessions(r.Context(), r.PathValue("id")); err != nil {
		WriteError(w, InternalServerError)
		return
	}
	WriteNoContent(w)
}

func (h *userHandlers) assignRole(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if err := h.Store.AssignRole(r.Context(), actor.ID, r.PathValue("id"), r.PathValue("roleId")); err != nil {
		h.writeStoreError(w, err)
		return
	}
	u, err := h.Store.GetUser(r.Context(), r.PathValue("id"))
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]store.PublicUser{"user": u})
}

func (h *userHandlers) removeRole(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if err := h.Store.RemoveRole(r.Context(), actor.ID, r.PathValue("id"), r.PathValue("roleId")); err != nil {
		h.writeStoreError(w, err)
		return
	}
	u, err := h.Store.GetUser(r.Context(), r.PathValue("id"))
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]store.PublicUser{"user": u})
}

func (h *userHandlers) listRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := h.Store.ListRoles(r.Context())
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusOK, map[string][]store.Role{"roles": roles})
}

type roleRequest struct {
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Permissions []string `json:"permissions"`
}

func (h *userHandlers) createRole(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	var req roleRequest
	if apiErr := DecodeJSON(r, &req); apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	if fields := validateRoleFields(req); fields != nil {
		WriteError(w, WithFields(fields))
		return
	}
	role, err := h.Store.CreateRole(r.Context(), actor.ID, req.Name, req.Label, req.Permissions)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteJSON(w, http.StatusCreated, map[string]store.Role{"role": role})
}

func (h *userHandlers) renameRole(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	var req roleRequest
	if apiErr := DecodeJSON(r, &req); apiErr != nil {
		WriteError(w, apiErr)
		return
	}
	if fields := validateRoleFields(req); fields != nil {
		WriteError(w, WithFields(fields))
		return
	}
	role, err := h.Store.RenameRole(r.Context(), actor.ID, r.PathValue("roleId"), req.Name, req.Label, req.Permissions)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]store.Role{"role": role})
}

func (h *userHandlers) deleteRole(w http.ResponseWriter, r *http.Request) {
	actor := mustActor(r)
	if err := h.Store.DeleteRole(r.Context(), actor.ID, r.PathValue("roleId")); err != nil {
		h.writeStoreError(w, err)
		return
	}
	WriteNoContent(w)
}

func (h *userHandlers) listPermissions(w http.ResponseWriter, r *http.Request) {
	perms, err := h.Store.ListPermissions(r.Context())
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusOK, map[string][]store.Permission{"permissions": perms})
}

func (h *userHandlers) audit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.AuditFilter{
		ActorID:    q.Get("actor"),
		Action:     q.Get("action"),
		TargetType: q.Get("targetType"),
		TargetID:   q.Get("targetId"),
	}
	if c := q.Get("cursor"); c != "" {
		v, err := strconv.ParseInt(c, 10, 64)
		if err != nil || v < 0 {
			WriteError(w, WithFields(map[string]string{"cursor": "Must be a non-negative integer."}))
			return
		}
		f.Cursor = v
	}
	if l := q.Get("limit"); l != "" {
		v, err := strconv.Atoi(l)
		if err != nil || v < 1 || v > auditMaxLimit {
			WriteError(w, WithFields(map[string]string{"limit": "Must be between 1 and 50."}))
			return
		}
		f.Limit = v
	}
	page, err := h.Store.ListAudit(r.Context(), f)
	if err != nil {
		WriteError(w, InternalServerError)
		return
	}
	WriteJSON(w, http.StatusOK, page)
}

// hashWithLimiter runs Argon2id derivation through the shared two-slot
// limiter, returning authentication_busy when saturated.
func (h *userHandlers) hashWithLimiter(r *http.Request, password string) (string, *APIError) {
	release, err := h.Limiter.Acquire(r.Context(), 2*time.Second)
	if err != nil {
		if errors.Is(err, auth.ErrBusy) {
			return "", withRetryAfter(AuthenticationBusy)
		}
		return "", InternalServerError
	}
	hash, err := hashPassword([]byte(password))
	release()
	if err != nil {
		return "", InternalServerError
	}
	return hash, nil
}

func (h *userHandlers) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		WriteError(w, NotFound)
	case errors.Is(err, store.ErrUsernameTaken):
		WriteError(w, UsernameTaken)
	case errors.Is(err, store.ErrRoleConflict):
		WriteError(w, RoleConflict)
	case errors.Is(err, store.ErrImmutableTarget):
		WriteError(w, ImmutableTarget)
	default:
		WriteError(w, InternalServerError)
	}
}

// validateRoleFields returns field errors for a role request, or nil.
func validateRoleFields(req roleRequest) map[string]string {
	fields := map[string]string{}
	if !validRoleName(req.Name) {
		fields["name"] = "Use 3 to 64 letters, numbers, dots, underscores, or hyphens."
	}
	if l := len(req.Label); l < 1 || l > 64 {
		fields["label"] = "Use 1 to 128 characters."
	}
	if len(fields) == 0 {
		return nil
	}
	return fields
}

func validRoleName(s string) bool { return validUsername(s) }

// hashPassword is swappable in tests.
var hashPassword = defaultHashPassword

// mustActor reads the authenticated identity placed by SessionMiddleware.
func mustActor(r *http.Request) *store.SessionUser {
	u, _ := SessionFrom(r.Context())
	return u
}
