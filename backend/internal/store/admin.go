package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Errors mapped by handlers to stable API codes.
var (
	ErrNotFound        = errors.New("not found")
	ErrRoleConflict    = errors.New("role conflict")
	ErrImmutableTarget = errors.New("immutable target")
)

// Role is a role row with its permissions.
type Role struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Protected   bool     `json:"protected"`
	Permissions []string `json:"permissions"`
}

// SessionInfo is the non-secret view of a session for the sessions API.
type SessionInfo struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
}

// AuditEntry is one append-only audit record.
type AuditEntry struct {
	ID         int64           `json:"id"`
	ActorID    *string         `json:"actorId"`
	Action     string          `json:"action"`
	TargetType string          `json:"targetType"`
	TargetID   *string         `json:"targetId"`
	Metadata   json.RawMessage `json:"metadata"`
	CreatedAt  string          `json:"createdAt"`
}

// AuditPage is one cursor page of audit entries.
type AuditPage struct {
	Entries      []AuditEntry `json:"entries"`
	NextCursor   *string      `json:"nextCursor"`
	HasMore      bool         `json:"hasMore"`
}

// AuditFilter narrows audit queries.
type AuditFilter struct {
	ActorID    string
	Action     string
	TargetType string
	TargetID   string
	Cursor     int64
	Limit      int
}

const auditPageLimit = 50

func mapStoreError(err error, notFoundConstraint string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			if notFoundConstraint == "" {
				return ErrRoleConflict
			}
			if pgErr.ConstraintName == notFoundConstraint {
				return ErrUsernameTaken
			}
			return ErrRoleConflict
		case "23503":
			return ErrRoleConflict
		}
	}
	return err
}

// GetUser returns one live (non-deleted) user by ID.
func (s *Store) GetUser(ctx context.Context, id string) (PublicUser, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT u.id::text, u.username, u.is_root, u.status,
		       to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		       COALESCE(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}')
		FROM users u
		LEFT JOIN user_roles ur ON ur.user_id = u.id
		LEFT JOIN roles r ON r.id = ur.role_id
		WHERE u.id = $1 AND u.deleted_at IS NULL
		GROUP BY u.id, u.username, u.is_root, u.status, u.created_at
	`, id)
	var u PublicUser
	var roles []string
	err := row.Scan(&u.ID, &u.Username, &u.IsRoot, &u.Status, &u.CreatedAt, &roles)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicUser{}, ErrNotFound
	}
	if err != nil {
		return PublicUser{}, fmt.Errorf("querying user: %w", err)
	}
	u.Roles = orEmpty(roles)
	return u, nil
}

// userRowID resolves a live user by ID and reports whether it is root.
// Deleted users are not found; the root user is always live.
func (s *Store) userRowID(ctx context.Context, id string) (userID string, username string, isRoot bool, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT id::text, username, is_root FROM users
		WHERE id = $1 AND deleted_at IS NULL
	`, id).Scan(&userID, &username, &isRoot)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, ErrNotFound
	}
	return userID, username, isRoot, err
}

// UpdateUsername renames a live user in one transaction with an audit row.
func (s *Store) UpdateUsername(ctx context.Context, actorID, targetID, username string) (PublicUser, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PublicUser{}, fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	target, username0, isRoot, err := txUser(ctx, tx, targetID)
	if err != nil {
		return PublicUser{}, err
	}
	if isRoot {
		return PublicUser{}, ErrImmutableTarget
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users SET username = $1, updated_at = now() WHERE id = $2
	`, username, target); err != nil {
		return PublicUser{}, mapStoreError(err, "users_username_lower_key")
	}
	if err := txAudit(ctx, tx, actorID, "user.username_updated", "user", target,
		map[string]any{"from": username0, "to": username}); err != nil {
		return PublicUser{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PublicUser{}, fmt.Errorf("committing username update: %w", err)
	}
	return s.GetUser(ctx, target)
}

// ResetPassword stores a new hash and revokes the target's sessions in one
// transaction with an audit row.
func (s *Store) ResetPassword(ctx context.Context, actorID, targetID, passwordHash string) (PublicUser, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PublicUser{}, fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	target, username, isRoot, err := txUser(ctx, tx, targetID)
	if err != nil {
		return PublicUser{}, err
	}
	if isRoot {
		return PublicUser{}, ErrImmutableTarget
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2
	`, passwordHash, target); err != nil {
		return PublicUser{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, target); err != nil {
		return PublicUser{}, err
	}
	if err := txAudit(ctx, tx, actorID, "user.password_reset", "user", target,
		map[string]any{"username": username}); err != nil {
		return PublicUser{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PublicUser{}, fmt.Errorf("committing password reset: %w", err)
	}
	return s.GetUser(ctx, targetID)
}

// SetSuspended suspends or reactivates a live user, revoking sessions on
// suspension, in one transaction with an audit row.
func (s *Store) SetSuspended(ctx context.Context, actorID, targetID string, suspended bool) (PublicUser, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PublicUser{}, fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	target, username, isRoot, err := txUser(ctx, tx, targetID)
	if err != nil {
		return PublicUser{}, err
	}
	if isRoot {
		return PublicUser{}, ErrImmutableTarget
	}
	status := "active"
	if suspended {
		status = "suspended"
	}
	tag, err := tx.Exec(ctx, `
		UPDATE users SET status = $1, updated_at = now() WHERE id = $2 AND status <> $1
	`, status, target)
	if err != nil {
		return PublicUser{}, err
	}
	if tag.RowsAffected() == 0 {
		return PublicUser{}, ErrRoleConflict
	}
	if suspended {
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, target); err != nil {
			return PublicUser{}, err
		}
	}
	action := "user.suspended"
	if !suspended {
		action = "user.reactivated"
	}
	if err := txAudit(ctx, tx, actorID, action, "user", target,
		map[string]any{"username": username}); err != nil {
		return PublicUser{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PublicUser{}, fmt.Errorf("committing suspension: %w", err)
	}
	return s.GetUser(ctx, targetID)
}

// SoftDeleteUser marks a user deleted, removes its sessions, and detaches
// roles, in one transaction with an audit row.
func (s *Store) SoftDeleteUser(ctx context.Context, actorID, targetID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	target, username, isRoot, err := txUser(ctx, tx, targetID)
	if err != nil {
		return err
	}
	if isRoot {
		return ErrImmutableTarget
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users SET deleted_at = now(), status = 'suspended', updated_at = now()
		WHERE id = $1
	`, target); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, target); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_roles WHERE user_id = $1`, target); err != nil {
		return err
	}
	if err := txAudit(ctx, tx, actorID, "user.deleted", "user", target,
		map[string]any{"username": username}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing deletion: %w", err)
	}
	return nil
}

// RestoreUser reactivates a soft-deleted user. The username stays reserved
// by the unique index, so a deleted user can only be restored, never
// recreated under a taken name.
func (s *Store) RestoreUser(ctx context.Context, actorID, targetID string) (PublicUser, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PublicUser{}, fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var username string
	err = tx.QueryRow(ctx, `
		SELECT username FROM users WHERE id = $1 AND deleted_at IS NOT NULL
	`, targetID).Scan(&username)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicUser{}, ErrNotFound
	}
	if err != nil {
		return PublicUser{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users SET deleted_at = NULL, status = 'active', updated_at = now()
		WHERE id = $1
	`, targetID); err != nil {
		return PublicUser{}, err
	}
	// Ensure the fixed user role is present again.
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_roles (user_id, role_id)
		SELECT $1, id FROM roles WHERE name = 'user'
		ON CONFLICT DO NOTHING
	`, targetID); err != nil {
		return PublicUser{}, err
	}
	if err := txAudit(ctx, tx, actorID, "user.restored", "user", targetID,
		map[string]any{"username": username}); err != nil {
		return PublicUser{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PublicUser{}, fmt.Errorf("committing restore: %w", err)
	}
	return s.GetUser(ctx, targetID)
}

// ListUserSessions returns non-secret session views for a user.
func (s *Store) ListUserSessions(ctx context.Context, userID string) ([]SessionInfo, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text,
		       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		       to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM sessions WHERE user_id = $1
		ORDER BY created_at, id
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("listing sessions: %w", err)
	}
	defer rows.Close()
	var out []SessionInfo
	for rows.Next() {
		var si SessionInfo
		if err := rows.Scan(&si.ID, &si.CreatedAt, &si.ExpiresAt); err != nil {
			return nil, fmt.Errorf("scanning session: %w", err)
		}
		out = append(out, si)
	}
	if out == nil {
		out = []SessionInfo{}
	}
	return out, rows.Err()
}

// RevokeSession deletes one session belonging to the user. It reports
// ErrNotFound when the session does not exist or belongs to someone else.
func (s *Store) RevokeSession(ctx context.Context, userID, sessionID string) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM sessions WHERE id = $1::uuid AND user_id = $2
	`, sessionID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RevokeAllSessions deletes every session belonging to the user.
func (s *Store) RevokeAllSessions(ctx context.Context, userID string) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// GetRole returns one role with its permission names.
func (s *Store) GetRole(ctx context.Context, roleID string) (Role, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.name, r.label, r.protected,
		       COALESCE(array_agg(p.name ORDER BY p.name) FILTER (WHERE p.name IS NOT NULL), '{}')
		FROM roles r
		LEFT JOIN role_permissions rp ON rp.role_id = r.id
		LEFT JOIN permissions p ON p.id = rp.permission_id
		WHERE r.id = $1::uuid
		GROUP BY r.id, r.name, r.label, r.protected
	`, roleID)
	if err != nil {
		return Role{}, fmt.Errorf("querying role: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return Role{}, ErrNotFound
	}
	var ro Role
	var perms []string
	if err := rows.Scan(&ro.ID, &ro.Name, &ro.Label, &ro.Protected, &perms); err != nil {
		return Role{}, err
	}
	ro.Permissions = orEmpty(perms)
	return ro, rows.Err()
}

// ListRoles returns every role with its permission names, ordered by name.
func (s *Store) ListRoles(ctx context.Context) ([]Role, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.name, r.label, r.protected,
		       COALESCE(array_agg(p.name ORDER BY p.name) FILTER (WHERE p.name IS NOT NULL), '{}')
		FROM roles r
		LEFT JOIN role_permissions rp ON rp.role_id = r.id
		LEFT JOIN permissions p ON p.id = rp.permission_id
		GROUP BY r.id, r.name, r.label, r.protected
		ORDER BY r.name
	`)
	if err != nil {
		return nil, fmt.Errorf("listing roles: %w", err)
	}
	defer rows.Close()
	var out []Role
	for rows.Next() {
		var ro Role
		var perms []string
		if err := rows.Scan(&ro.ID, &ro.Name, &ro.Label, &ro.Protected, &perms); err != nil {
			return nil, fmt.Errorf("scanning role: %w", err)
		}
		ro.Permissions = orEmpty(perms)
		out = append(out, ro)
	}
	return out, rows.Err()
}

// CreateRole inserts a role with the given permissions in one transaction
// with an audit row.
func (s *Store) CreateRole(ctx context.Context, actorID, name, label string, permissions []string) (Role, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Role{}, fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO roles (name, label) VALUES ($1, $2)
		RETURNING id::text
	`, name, label).Scan(&id)
	if err != nil {
		return Role{}, mapStoreError(err, "")
	}
	if err := txSetRolePermissions(ctx, tx, id, permissions); err != nil {
		return Role{}, err
	}
	if err := txAudit(ctx, tx, actorID, "role.created", "role", id,
		map[string]any{"name": name, "permissions": permissions}); err != nil {
		return Role{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Role{}, fmt.Errorf("committing role: %w", err)
	}
	return Role{ID: id, Name: name, Label: label, Protected: false, Permissions: orEmptyIDs(permissions)}, nil
}

// RenameRole updates a non-protected role's name, label, and (when provided)
// permissions in one transaction with an audit row.
func (s *Store) RenameRole(ctx context.Context, actorID, roleID, name, label string, permissions ...[]string) (Role, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Role{}, fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var protected bool
	var oldName string
	err = tx.QueryRow(ctx, `SELECT name, protected FROM roles WHERE id = $1::uuid`, roleID).
		Scan(&oldName, &protected)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, err
	}
	if protected {
		return Role{}, ErrImmutableTarget
	}
	if _, err := tx.Exec(ctx, `UPDATE roles SET name = $1, label = $2 WHERE id = $3::uuid`,
		name, label, roleID); err != nil {
		return Role{}, mapStoreError(err, "")
	}
	if len(permissions) > 0 && permissions[0] != nil {
		if err := txSetRolePermissions(ctx, tx, roleID, permissions[0]); err != nil {
			return Role{}, err
		}
	}
	if err := txAudit(ctx, tx, actorID, "role.renamed", "role", roleID,
		map[string]any{"from": oldName, "to": name, "label": label}); err != nil {
		return Role{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Role{}, fmt.Errorf("committing role rename: %w", err)
	}
	return s.GetRole(ctx, roleID)
}

// DeleteRole removes a non-protected role in one transaction with an audit
// row. Assignments cascade.
func (s *Store) DeleteRole(ctx context.Context, actorID, roleID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var protected bool
	var name string
	err = tx.QueryRow(ctx, `SELECT name, protected FROM roles WHERE id = $1::uuid`, roleID).
		Scan(&name, &protected)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if protected {
		return ErrImmutableTarget
	}
	if _, err := tx.Exec(ctx, `DELETE FROM roles WHERE id = $1::uuid`, roleID); err != nil {
		return err
	}
	if err := txAudit(ctx, tx, actorID, "role.deleted", "role", roleID,
		map[string]any{"name": name}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AssignRole grants one role to a user in one transaction with an audit row.
func (s *Store) AssignRole(ctx context.Context, actorID, userID, roleID string) error {
	return s.changeUserRole(ctx, actorID, userID, roleID, "user.role_assigned", true)
}

// RemoveRole revokes one role from a user. Revoking root from the root user
// is blocked to preserve the invariant that root keeps authorization.
func (s *Store) RemoveRole(ctx context.Context, actorID, userID, roleID string) error {
	return s.changeUserRole(ctx, actorID, userID, roleID, "user.role_removed", false)
}

func (s *Store) changeUserRole(ctx context.Context, actorID, userID, roleID, action string, grant bool) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var targetName string
	var isRoot bool
	err = tx.QueryRow(ctx, `
		SELECT username, is_root FROM users WHERE id = $1::uuid AND deleted_at IS NULL
	`, userID).Scan(&targetName, &isRoot)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var roleName string
	var roleProtected bool
	err = tx.QueryRow(ctx, `SELECT name, protected FROM roles WHERE id = $1::uuid`, roleID).
		Scan(&roleName, &roleProtected)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if isRoot && roleName == "root" {
		// Root user must always hold the root role; removal is blocked,
		// granting it again is a no-op success.
		if !grant {
			return ErrImmutableTarget
		}
		return nil
	}
	if grant {
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_roles (user_id, role_id) VALUES ($1::uuid, $2::uuid)
			ON CONFLICT DO NOTHING
		`, userID, roleID); err != nil {
			return err
		}
	} else {
		tag, err := tx.Exec(ctx, `DELETE FROM user_roles WHERE user_id = $1::uuid AND role_id = $2::uuid`,
			userID, roleID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrRoleConflict
		}
	}
	if err := txAudit(ctx, tx, actorID, action, "user", userID,
		map[string]any{"role": roleName, "username": targetName}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing role change: %w", err)
	}
	return nil
}

// ListPermissions returns every permission name and label.
func (s *Store) ListPermissions(ctx context.Context) ([]Permission, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id::text, name, label FROM permissions ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("listing permissions: %w", err)
	}
	defer rows.Close()
	var out []Permission
	for rows.Next() {
		var p Permission
		if err := rows.Scan(&p.ID, &p.Name, &p.Label); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListAudit returns one cursor page of audit entries.
func (s *Store) ListAudit(ctx context.Context, f AuditFilter) (AuditPage, error) {
	limit := f.Limit
	if limit <= 0 || limit > auditPageLimit {
		limit = auditPageLimit
	}
	where := strings.Builder{}
	where.WriteString(" WHERE 1=1")
	args := []any{}
	add := func(cond string, v any) {
		args = append(args, v)
		where.WriteString(" AND " + strings.Replace(cond, "?", fmt.Sprintf("$%d", len(args)), 1))
	}
	if f.ActorID != "" {
		add("actor_id = ?", f.ActorID)
	}
	if f.Action != "" {
		add("action = ?", f.Action)
	}
	if f.TargetType != "" {
		add("target_type = ?", f.TargetType)
	}
	if f.TargetID != "" {
		add("target_id = ?", f.TargetID)
	}
	if f.Cursor > 0 {
		add("id < ?", f.Cursor)
	}
	// Fetch one extra row to detect hasMore.
	rows, err := s.pool.Query(ctx, `
		SELECT id, actor_id::text, action, target_type, target_id,
		       metadata::text,
		       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM audit_logs`+where.String()+" ORDER BY id DESC LIMIT "+fmt.Sprint(limit+1), args...)
	if err != nil {
		return AuditPage{}, fmt.Errorf("listing audit: %w", err)
	}
	defer rows.Close()
	var entries []AuditEntry
	for rows.Next() {
		var e AuditEntry
		var meta string
		if err := rows.Scan(&e.ID, &e.ActorID, &e.Action, &e.TargetType, &e.TargetID, &meta, &e.CreatedAt); err != nil {
			return AuditPage{}, fmt.Errorf("scanning audit: %w", err)
		}
		e.Metadata = json.RawMessage(meta)
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return AuditPage{}, err
	}
	page := AuditPage{Entries: entries}
	if len(entries) > limit {
		page.Entries = entries[:limit]
		page.HasMore = true
		next := fmt.Sprint(entries[limit-1].ID)
		page.NextCursor = &next
	}
	if page.Entries == nil {
		page.Entries = []AuditEntry{}
	}
	return page, nil
}

func txUser(ctx context.Context, tx pgx.Tx, id string) (userID, username string, isRoot bool, err error) {
	err = tx.QueryRow(ctx, `
		SELECT id::text, username, is_root FROM users
		WHERE id = $1::uuid AND deleted_at IS NULL
	`, id).Scan(&userID, &username, &isRoot)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, ErrNotFound
	}
	return
}

func txAudit(ctx context.Context, tx pgx.Tx, actorID, action, targetType string, targetID any, metadata map[string]any) error {
	meta, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("encoding audit metadata: %w", err)
	}
	var tid *string
	if s, ok := targetID.(string); ok {
		tid = &s
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
		VALUES (NULLIF($1, '')::uuid, $2, $3, $4, $5::jsonb)
	`, actorID, action, targetType, tid, meta); err != nil {
		return fmt.Errorf("writing audit row: %w", err)
	}
	return nil
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func orEmptyIDs(s []string) []string { return orEmpty(s) }

func txSetRolePermissions(ctx context.Context, tx pgx.Tx, roleID string, permissions []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1::uuid`, roleID); err != nil {
		return err
	}
	for _, p := range permissions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO role_permissions (role_id, permission_id)
			SELECT $1::uuid, id FROM permissions WHERE name = $2
		`, roleID, p); err != nil {
			return err
		}
	}
	return nil
}


