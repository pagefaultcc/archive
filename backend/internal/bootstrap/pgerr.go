package bootstrap

import (
	"github.com/jackc/pgx/v5/pgconn"
)

func isUniqueUsername(err error) bool {
	pgErr, ok := err.(*pgconn.PgError)
	return ok && pgErr.Code == "23505" && pgErr.ConstraintName == "users_username_lower_key"
}

func isOneRoot(err error) bool {
	pgErr, ok := err.(*pgconn.PgError)
	return ok && pgErr.Code == "23505" && pgErr.ConstraintName == "users_one_root"
}
