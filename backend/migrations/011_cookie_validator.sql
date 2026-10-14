-- +goose Up
CREATE TABLE cookie_validation_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL DEFAULT 'chatgpt',
    domain TEXT NOT NULL,
    archive_id UUID REFERENCES archives(id) ON DELETE CASCADE,
    archive_filename TEXT NOT NULL DEFAULT '',
    entry_path TEXT NOT NULL DEFAULT '',
    cookie_count INT NOT NULL DEFAULT 0,
    cookie_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'not_checked'
        CHECK (status IN ('not_checked', 'valid', 'not_valid')),
    checked_at TIMESTAMPTZ,
    error_message TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cookie_validation_items_status_idx ON cookie_validation_items (status, created_at DESC);
CREATE INDEX cookie_validation_items_domain_idx ON cookie_validation_items (domain);

-- +goose Down
DROP TABLE IF EXISTS cookie_validation_items;
