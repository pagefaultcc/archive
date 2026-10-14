-- +goose Up
CREATE TABLE IF NOT EXISTS telegram_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    password_script TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_channels_channel_id_idx ON telegram_channels (channel_id);

-- +goose Down
DROP TABLE IF EXISTS telegram_channels;
