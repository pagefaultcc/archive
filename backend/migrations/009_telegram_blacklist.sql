-- +goose Up
CREATE TABLE IF NOT EXISTS telegram_blacklist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id TEXT NOT NULL,
    message_id BIGINT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT 'bad_password',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT telegram_blacklist_channel_msg_unique UNIQUE (channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS telegram_blacklist_channel_idx ON telegram_blacklist (channel_id);
CREATE INDEX IF NOT EXISTS telegram_blacklist_sha256_idx ON telegram_blacklist (sha256);

-- +goose Down
DROP TABLE IF EXISTS telegram_blacklist;
