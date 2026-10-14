-- +goose Up
ALTER TABLE archives DROP CONSTRAINT IF EXISTS archives_status_check;
ALTER TABLE archives ADD CONSTRAINT archives_status_check
    CHECK (status IN ('indexed', 'password_required', 'failed', 'deleting'));

-- +goose Down
ALTER TABLE archives DROP CONSTRAINT IF EXISTS archives_status_check;
ALTER TABLE archives ADD CONSTRAINT archives_status_check
    CHECK (status IN ('indexed', 'password_required', 'failed'));
