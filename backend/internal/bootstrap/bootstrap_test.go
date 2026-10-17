package bootstrap

import (
	"os"
	"sync"
	"testing"
)

func testURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("TEST_DATABASE_URL")
	if u == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	return u
}

func resetSchema(t *testing.T, url string) {
	t.Helper()
	db := open(t, url)
	defer db.Close()
	for _, stmt := range []string{
		`DROP TABLE IF EXISTS audit_logs, sessions, role_permissions, user_roles, permissions, roles, users CASCADE`,
		`DROP TABLE IF EXISTS archive_cookie_domains, archive_credentials, cookie_validation_items, telegram_channels, telegram_blacklist, app_settings CASCADE`,
		`DROP TABLE IF EXISTS archives, archive_entries CASCADE`,
		`DROP TABLE IF EXISTS goose_db_version CASCADE`,
		`DROP FUNCTION IF EXISTS audit_logs_append_only() CASCADE`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("reset: %v", err)
		}
	}
}

func open(t *testing.T, url string) *sqlDB { return openDB(t, url) }

const rootUser = "playersclub"
const rootPass = "test-root-password"

func TestFirstBootstrap(t *testing.T) {
	url := testURL(t)
	resetSchema(t, url)
	created, err := Run(ctx(), url, Options{RootUsername: rootUser, RootPassword: rootPass})
	if err != nil || !created {
		t.Fatalf("created=%v err=%v", created, err)
	}
	db := open(t, url)
	defer db.Close()
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM users WHERE is_root`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("roots=%d err=%v", count, err)
	}
	var hasRole bool
	_ = db.QueryRow(`SELECT EXISTS (
		SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
		WHERE u.is_root AND r.name='root')`).Scan(&hasRole)
	if !hasRole {
		t.Fatal("root role missing")
	}
}

func TestBootstrapMissingValues(t *testing.T) {
	url := testURL(t)
	resetSchema(t, url)
	if _, err := Run(ctx(), url, Options{RootUsername: "", RootPassword: rootPass}); err == nil {
		t.Fatal("empty username must fail")
	}
	if _, err := Run(ctx(), url, Options{RootUsername: rootUser, RootPassword: ""}); err == nil {
		t.Fatal("empty password must fail")
	}
}

func TestBootstrapRestartPreservesHash(t *testing.T) {
	url := testURL(t)
	resetSchema(t, url)
	if _, err := Run(ctx(), url, Options{RootUsername: rootUser, RootPassword: rootPass}); err != nil {
		t.Fatal(err)
	}
	db := open(t, url)
	var hash1, hash2 string
	var id1, id2 string
	if err := db.QueryRow(`SELECT id::text, password_hash FROM users WHERE is_root`).Scan(&id1, &hash1); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := Run(ctx(), url, Options{RootUsername: rootUser, RootPassword: ""}); err != nil {
		t.Fatalf("restart: %v", err)
	}
	db = open(t, url)
	defer db.Close()
	if err := db.QueryRow(`SELECT id::text, password_hash FROM users WHERE is_root`).Scan(&id2, &hash2); err != nil {
		t.Fatal(err)
	}
	if id1 != id2 || hash1 != hash2 {
		t.Fatal("restart mutated root identity or hash")
	}
}

func TestBootstrapNameConflict(t *testing.T) {
	url := testURL(t)
	resetSchema(t, url)
	if _, err := Run(ctx(), url, Options{RootUsername: rootUser, RootPassword: rootPass}); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(ctx(), url, Options{RootUsername: "other", RootPassword: rootPass}); err == nil {
		t.Fatal("configured-name conflict must fail without mutation")
	}
}

func TestConcurrentBootstrapsOneRoot(t *testing.T) {
	url := testURL(t)
	resetSchema(t, url)
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = Run(ctx(), url, Options{RootUsername: rootUser, RootPassword: rootPass})
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatalf("concurrent bootstrap: %v", err)
		}
	}
	db := open(t, url)
	defer db.Close()
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM users WHERE is_root`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("roots=%d err=%v", count, err)
	}
}

func TestRootRoleRepair(t *testing.T) {
	url := testURL(t)
	resetSchema(t, url)
	if _, err := Run(ctx(), url, Options{RootUsername: rootUser, RootPassword: rootPass}); err != nil {
		t.Fatal(err)
	}
	db := open(t, url)
	if _, err := db.Exec(`DELETE FROM user_roles WHERE role_id = (SELECT id FROM roles WHERE name='root')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := Run(ctx(), url, Options{RootUsername: rootUser, RootPassword: "anything"}); err != nil {
		t.Fatal(err)
	}
	db = open(t, url)
	defer db.Close()
	var hasRole bool
	if err := db.QueryRow(`SELECT EXISTS (
		SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
		WHERE u.is_root AND r.name='root')`).Scan(&hasRole); err != nil || !hasRole {
		t.Fatalf("role not repaired: %v", err)
	}
}

func TestDatabaseEnforcesSingleRoot(t *testing.T) {
	url := testURL(t)
	resetSchema(t, url)
	if _, err := Run(ctx(), url, Options{RootUsername: rootUser, RootPassword: rootPass}); err != nil {
		t.Fatal(err)
	}
	db := open(t, url)
	defer db.Close()
	_, err := db.Exec(`INSERT INTO users (username, password_hash, is_root) VALUES ('x', 'y', TRUE)`)
	if err == nil {
		t.Fatal("second root must violate unique index")
	}
}
