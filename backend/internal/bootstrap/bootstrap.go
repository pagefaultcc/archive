package bootstrap

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"archive/backend/internal/auth"
	"archive/backend/migrations"
)

// Options are the bootstrap inputs.
type Options struct {
	RootUsername string
	RootPassword string
	Hasher       func(password []byte) (string, error)
}

// Run opens exactly one session, acquires a session-level advisory lock on
// it, runs embedded goose migrations and root bootstrap through that same
// session, and releases the lock only after commit. It returns true when a
// root was newly created, false when an existing root was verified.
func Run(ctx context.Context, databaseURL string, opts Options) (created bool, err error) {
	if opts.Hasher == nil {
		opts.Hasher = func(pw []byte) (string, error) { return auth.Hash(pw, auth.DefaultParams) }
	}
	if opts.RootUsername == "" {
		return false, errors.New("ROOT_USERNAME is required to bootstrap the root user")
	}

	connCfg, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return false, fmt.Errorf("parsing DATABASE_URL: %w", err)
	}
	db := stdlib.OpenDB(*connCfg)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	defer db.Close()

	const lockKey = 918273645
	if _, err := db.ExecContext(ctx, "SELECT pg_advisory_lock($1)", lockKey); err != nil {
		return false, fmt.Errorf("acquiring migration lock: %w", err)
	}
	defer func() {
		if _, err := db.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", lockKey); err != nil {
			err = fmt.Errorf("releasing migration lock: %w", err)
		}
	}()

	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return false, fmt.Errorf("goose dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db, "."); err != nil {
		return false, fmt.Errorf("running migrations: %w", err)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("beginning bootstrap transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var rootID string
	var rootName string
	err = tx.QueryRowContext(ctx, "SELECT id::text, username FROM users WHERE is_root").Scan(&rootID, &rootName)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		created, err = createRoot(ctx, tx, opts)
		if err != nil {
			return false, err
		}
	case err != nil:
		return false, fmt.Errorf("querying root: %w", err)
	default:
		if !strings.EqualFold(rootName, opts.RootUsername) {
			return false, fmt.Errorf("existing root username %q does not match ROOT_USERNAME %q", rootName, opts.RootUsername)
		}
		if err := repairRootRole(ctx, tx, rootID); err != nil {
			return false, err
		}
	}

	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("committing bootstrap: %w", err)
	}
	return created, nil
}

func createRoot(ctx context.Context, tx *sql.Tx, opts Options) (bool, error) {
	if opts.RootPassword == "" {
		return false, errors.New("ROOT_PASSWORD is required to bootstrap the root user")
	}
	hash, err := opts.Hasher([]byte(opts.RootPassword))
	if err != nil {
		return false, fmt.Errorf("hashing root password: %w", err)
	}
	var id string
	err = tx.QueryRowContext(ctx, `
		INSERT INTO users (username, password_hash, is_root)
		VALUES ($1, $2, TRUE)
		RETURNING id::text
	`, opts.RootUsername, hash).Scan(&id)
	if err != nil {
		if isUniqueUsername(err) {
			return false, fmt.Errorf("username %q already taken", opts.RootUsername)
		}
		if isOneRoot(err) {
			return false, errors.New("a root user already exists")
		}
		return false, fmt.Errorf("inserting root: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_roles (user_id, role_id)
		SELECT $1, id FROM roles WHERE name = 'root'
	`, id); err != nil {
		return false, fmt.Errorf("assigning root role: %w", err)
	}
	return true, nil
}

func repairRootRole(ctx context.Context, tx *sql.Tx, rootID string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO user_roles (user_id, role_id)
		SELECT $1, id FROM roles WHERE name = 'root'
		ON CONFLICT DO NOTHING
	`, rootID)
	if err != nil {
		return fmt.Errorf("repairing root role: %w", err)
	}
	return nil
}
