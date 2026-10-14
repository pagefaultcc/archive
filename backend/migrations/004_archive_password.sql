-- +goose Up
ALTER TABLE archives
    ADD COLUMN IF NOT EXISTS archive_password TEXT NOT NULL DEFAULT '';

DELETE FROM archives WHERE status = 'password_required';

-- +goose Down
ALTER TABLE archives
    DROP COLUMN IF EXISTS archive_password;
