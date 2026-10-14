-- +goose Up
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default fast cloud dictionary passwords
INSERT INTO app_settings (key, value)
VALUES (
    'archive_passwords',
    '["@HUNTER_CLOUD", "@updh1", "@fatetraffic", "@darkside_cloud_info", "@HUNTER_CLOUDS", "@UP_DAISYCLOUD", "https://t.me/AhegaoCloud", "@BurnCloudLogs", "@PIXELCLOUD3", "@TXTMASTER_PUBLIC", "infected", "1234", "12345", "password"]'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- +goose Down
DROP TABLE IF EXISTS app_settings;
