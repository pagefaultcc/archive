-- +goose Up
CREATE INDEX IF NOT EXISTS archive_credentials_login_trgm_idx ON archive_credentials USING gin (lower(login) gin_trgm_ops);

-- +goose Down
DROP INDEX IF EXISTS archive_credentials_login_trgm_idx;
