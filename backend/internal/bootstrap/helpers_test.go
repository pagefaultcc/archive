package bootstrap

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type sqlDB = sql.DB

func openDB(t *testing.T, url string) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return db
}

func ctx() context.Context {
	c, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	_ = cancel // tests close via db.Close; context bounded by suite timeout
	return c
}

// Skip helper when no database is configured (mirrors bootstrap_test.go).
func skipNoDB(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
}
