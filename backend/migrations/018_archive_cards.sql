-- +goose Up
CREATE TABLE archive_cards (
    id BIGSERIAL PRIMARY KEY,
    archive_id UUID NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
    entry_path TEXT NOT NULL,
    entry_name TEXT NOT NULL,
    holder TEXT NOT NULL DEFAULT '',
    number TEXT NOT NULL DEFAULT '',
    exp_month TEXT NOT NULL DEFAULT '',
    exp_year TEXT NOT NULL DEFAULT '',
    cvv TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT ''
);

CREATE INDEX archive_cards_archive_idx ON archive_cards (archive_id);
CREATE INDEX archive_cards_id_desc_idx ON archive_cards (id DESC);
CREATE INDEX archive_cards_number_trgm_idx ON archive_cards USING gin (lower(number) gin_trgm_ops);
CREATE INDEX archive_cards_holder_trgm_idx ON archive_cards USING gin (lower(holder) gin_trgm_ops);
CREATE INDEX archive_cards_brand_idx ON archive_cards (lower(brand));

-- +goose Down
DROP TABLE IF EXISTS archive_cards;
