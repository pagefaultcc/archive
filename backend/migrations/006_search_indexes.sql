-- +goose Up
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram GIN indexes for sub-millisecond substring and regex search across 4.6M+ entries
CREATE INDEX IF NOT EXISTS archive_entries_name_trgm_idx
    ON archive_entries USING gin (lower(name) gin_trgm_ops)
    WHERE is_dir = false;

CREATE INDEX IF NOT EXISTS archive_entries_path_trgm_idx
    ON archive_entries USING gin (lower(path) gin_trgm_ops)
    WHERE is_dir = false;

-- +goose Down
DROP INDEX IF EXISTS archive_entries_name_trgm_idx;
DROP INDEX IF EXISTS archive_entries_path_trgm_idx;
