-- +goose Up
CREATE TABLE archive_credentials (
    id BIGSERIAL PRIMARY KEY,
    archive_id UUID NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
    entry_path TEXT NOT NULL,
    entry_name TEXT NOT NULL,
    url TEXT NOT NULL,
    domain TEXT NOT NULL,
    login TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT ''
);

CREATE INDEX archive_credentials_domain_id_idx ON archive_credentials (domain, id DESC);
CREATE INDEX archive_credentials_domain_trgm_idx ON archive_credentials USING gin (lower(domain) gin_trgm_ops);
CREATE INDEX archive_credentials_url_trgm_idx ON archive_credentials USING gin (lower(url) gin_trgm_ops);
CREATE INDEX archive_credentials_archive_idx ON archive_credentials (archive_id);

-- +goose Down
DROP TABLE IF EXISTS archive_credentials;
