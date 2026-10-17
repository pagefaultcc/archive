-- +goose Up
CREATE INDEX IF NOT EXISTS archives_sha256_idx ON archives (sha256);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS archive_entries_lower_name_idx ON archive_entries (lower(name)) WHERE is_dir = false;

DROP INDEX IF EXISTS cookie_validation_items_status_idx;
CREATE INDEX IF NOT EXISTS cookie_validation_items_service_status_idx ON cookie_validation_items (service, status, created_at DESC, id DESC);

-- +goose Down
DROP INDEX IF EXISTS cookie_validation_items_service_status_idx;
CREATE INDEX IF NOT EXISTS cookie_validation_items_status_idx ON cookie_validation_items (status, created_at DESC);

DROP INDEX IF EXISTS archive_entries_lower_name_idx;
DROP INDEX IF EXISTS sessions_user_id_idx;
DROP INDEX IF EXISTS archives_sha256_idx;
