package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// User is the persistence view of a user row.
type User struct {
	ID           string
	Username     string
	PasswordHash string
	IsRoot       bool
	Status       string
	CreatedAt    time.Time
}

// PublicUser is the JSON contract for user payloads.
type PublicUser struct {
	ID        string   `json:"id"`
	Username  string   `json:"username"`
	IsRoot    bool     `json:"isRoot"`
	Status    string   `json:"status"`
	DeletedAt *string  `json:"deletedAt,omitempty"`
	Roles     []string `json:"roles"`
	CreatedAt string   `json:"createdAt"`
}

// SessionUser is the JSON contract for the authenticated identity.
type SessionUser struct {
	ID          string   `json:"id"`
	Username    string   `json:"username"`
	IsRoot      bool     `json:"isRoot"`
	Status      string   `json:"status"`
	Roles       []string `json:"roles"`
	Permissions []string `json:"permissions"`
}

// Permission is a permission row.
type Permission struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Label string `json:"label"`
}

// ErrUsernameTaken maps the case-insensitive unique violation.
var ErrUsernameTaken = errors.New("username taken")

// Store wraps the pgx pool and in-memory caches.
type Store struct {
	pool        *pgxpool.Pool
	cookieCache cookieDomainCache
}

type cookieDomainCache struct {
	mu           sync.RWMutex
	populated    bool
	loading      atomic.Bool
	allDomains   []CookieDomainSummary
	totalDomains int64
	totalLogs    int64
	totalCookies int64
	logsMu       sync.RWMutex
	domainLogs   map[string][]CookieDomainLogItem
}

// New opens a pool for the given URL.
func New(ctx context.Context, databaseURL string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parsing DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 25
	cfg.MinConns = 5
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connecting to database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}
	st := &Store{pool: pool}
	go func() {
		_ = st.ensureCookieDomainsLoaded(context.Background())
	}()
	return st, nil
}

// Close drains the pool.
func (s *Store) Close() { s.pool.Close() }

// Ping reports database readiness.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// UserByUsername finds a user case-insensitively.
func (s *Store) UserByUsername(ctx context.Context, username string) (User, bool, error) {
	var u User
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, username, password_hash, is_root, status, created_at
		FROM users WHERE lower(username) = lower($1)
	`, username).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.IsRoot, &u.Status, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, false, nil
	}
	if err != nil {
		return User{}, false, fmt.Errorf("querying user: %w", err)
	}
	return u, true, nil
}

// PermissionsFor resolves permission names for a user through roles.
func (s *Store) PermissionsFor(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT p.name
		FROM user_roles ur
		JOIN role_permissions rp ON rp.role_id = ur.role_id
		JOIN permissions p ON p.id = rp.permission_id
		WHERE ur.user_id = $1
		ORDER BY p.name
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("querying permissions: %w", err)
	}
	defer rows.Close()
	return collectNames(rows)
}

// RolesFor resolves role names for a user.
func (s *Store) RolesFor(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT r.name
		FROM user_roles ur
		JOIN roles r ON r.id = ur.role_id
		WHERE ur.user_id = $1
		ORDER BY r.name
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("querying roles: %w", err)
	}
	defer rows.Close()
	return collectNames(rows)
}

// ListUsers returns every live public user ordered by created_at then id, with
// aggregated role names from one query.
func (s *Store) ListUsers(ctx context.Context) ([]PublicUser, error) {
	return s.ListUsersAll(ctx, false)
}

// ListUsersAll returns public users ordered by created_at then id, optionally
// including soft-deleted rows.
func (s *Store) ListUsersAll(ctx context.Context, includeDeleted bool) ([]PublicUser, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT u.id::text, u.username, u.is_root, u.status,
		       CASE WHEN u.deleted_at IS NULL THEN NULL
		            ELSE to_char(u.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		       END,
		       to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		       COALESCE(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}')
		FROM users u
		LEFT JOIN user_roles ur ON ur.user_id = u.id
		LEFT JOIN roles r ON r.id = ur.role_id
		WHERE ($1::boolean OR u.deleted_at IS NULL)
		GROUP BY u.id, u.username, u.is_root, u.status, u.deleted_at, u.created_at
		ORDER BY u.created_at, u.id
	`, includeDeleted)
	if err != nil {
		return nil, fmt.Errorf("listing users: %w", err)
	}
	defer rows.Close()
	var out []PublicUser
	for rows.Next() {
		var u PublicUser
		var roles []string
		if err := rows.Scan(&u.ID, &u.Username, &u.IsRoot, &u.Status, &u.DeletedAt, &u.CreatedAt, &roles); err != nil {
			return nil, fmt.Errorf("scanning user: %w", err)
		}
		u.Roles = roles
		if u.Roles == nil {
			u.Roles = []string{}
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating users: %w", err)
	}
	return out, nil
}

// CreateUser inserts a user and assigns the fixed `user` role in one
// transaction. Returns ErrUsernameTaken on the case-insensitive collision.
func (s *Store) CreateUser(ctx context.Context, username, passwordHash string, actorID ...string) (PublicUser, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PublicUser{}, fmt.Errorf("beginning transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var id, createdAt string
	err = tx.QueryRow(ctx, `
		INSERT INTO users (username, password_hash)
		VALUES ($1, $2)
		RETURNING id::text, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
	`, username, passwordHash).Scan(&id, &createdAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_username_lower_key" {
			return PublicUser{}, ErrUsernameTaken
		}
		return PublicUser{}, fmt.Errorf("inserting user: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_roles (user_id, role_id)
		SELECT $1, id FROM roles WHERE name = 'user'
	`, id); err != nil {
		return PublicUser{}, fmt.Errorf("assigning user role: %w", err)
	}
	actor := ""
	if len(actorID) > 0 {
		actor = actorID[0]
	}
	if err := txAudit(ctx, tx, actor, "user.created", "user", id, map[string]any{"username": username}); err != nil {
		return PublicUser{}, fmt.Errorf("auditing user creation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PublicUser{}, fmt.Errorf("committing user: %w", err)
	}
	return PublicUser{ID: id, Username: username, IsRoot: false, Status: "active", Roles: []string{"user"}, CreatedAt: createdAt}, nil
}

// CreateSession persists only the SHA-256 digest of the raw token.
func (s *Store) CreateSession(ctx context.Context, tokenDigest, userID string, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (token_digest, user_id, expires_at)
		VALUES ($1, $2, $3)
	`, tokenDigest, userID, expiresAt)
	if err != nil {
		return fmt.Errorf("inserting session: %w", err)
	}
	return nil
}

// SessionUserByDigest resolves a live session to its SessionUser, skipping
// expired rows.
func (s *Store) SessionUserByDigest(ctx context.Context, tokenDigest string) (SessionUser, bool, error) {
	var u SessionUser
	err := s.pool.QueryRow(ctx, `
		SELECT u.id::text, u.username, u.is_root, u.status
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token_digest = $1 AND s.expires_at > now()
		  AND u.deleted_at IS NULL AND u.status = 'active'
	`, tokenDigest).Scan(&u.ID, &u.Username, &u.IsRoot, &u.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionUser{}, false, nil
	}
	if err != nil {
		return SessionUser{}, false, fmt.Errorf("querying session: %w", err)
	}
	roles, err := s.RolesFor(ctx, u.ID)
	if err != nil {
		return SessionUser{}, false, err
	}
	perms, err := s.PermissionsFor(ctx, u.ID)
	if err != nil {
		return SessionUser{}, false, err
	}
	u.Roles = roles
	u.Permissions = perms
	return u, true, nil
}

// DeleteSession removes the session row with the given digest.
func (s *Store) DeleteSession(ctx context.Context, tokenDigest string) error {
	_, err := s.pool.Exec(ctx, "DELETE FROM sessions WHERE token_digest = $1", tokenDigest)
	if err != nil {
		return fmt.Errorf("deleting session: %w", err)
	}
	return nil
}

// DeleteExpiredSessions purges expired rows and reports how many went.
func (s *Store) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, "DELETE FROM sessions WHERE expires_at <= now()")
	if err != nil {
		return 0, fmt.Errorf("deleting expired sessions: %w", err)
	}
	return tag.RowsAffected(), nil
}

// HasPermission reports whether the user holds the named permission via
// roles; this is the sole authorization source.
func (s *Store) HasPermission(ctx context.Context, userID, permission string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM user_roles ur
			JOIN role_permissions rp ON rp.role_id = ur.role_id
			JOIN permissions p ON p.id = rp.permission_id
			WHERE ur.user_id = $1 AND p.name = $2
		)
	`, userID, permission).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("checking permission: %w", err)
	}
	return ok, nil
}

func collectNames(rows pgx.Rows) ([]string, error) {
	defer rows.Close()
	names := make([]string, 0)
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, fmt.Errorf("scanning name: %w", err)
		}
		names = append(names, n)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating names: %w", err)
	}
	return names, nil
}
