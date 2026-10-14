-- +goose Up
CREATE TABLE archive_cookie_domains (
    id BIGSERIAL PRIMARY KEY,
    archive_id UUID NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
    entry_path TEXT NOT NULL,
    entry_name TEXT NOT NULL,
    domain TEXT NOT NULL,
    cookie_count INT NOT NULL DEFAULT 0,
    netscape_text TEXT NOT NULL,
    json_text TEXT NOT NULL
);

CREATE INDEX archive_cookie_domains_domain_idx ON archive_cookie_domains (domain, cookie_count DESC, id DESC);
CREATE INDEX archive_cookie_domains_archive_idx ON archive_cookie_domains (archive_id);

-- +goose Down
DROP TABLE IF EXISTS archive_cookie_domains;
