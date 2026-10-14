package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// TelegramChannel represents a configured Telegram source channel.
type TelegramChannel struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	ChannelID      string    `json:"channelId"`
	PasswordScript string    `json:"passwordScript"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// UserBotSettings represents global Telegram UserBot credentials.
type UserBotSettings struct {
	APIID         int    `json:"apiId"`
	APIHash       string `json:"apiHash"`
	SessionString string `json:"sessionString"`
	IsConfigured  bool   `json:"isConfigured"`
}

// GetTelegramSettings retrieves the global UserBot credentials.
func (s *Store) GetTelegramSettings(ctx context.Context) (UserBotSettings, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `
		SELECT value::text FROM app_settings WHERE key = 'telegram_userbot';
	`).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return UserBotSettings{}, nil
		}
		return UserBotSettings{}, fmt.Errorf("loading telegram userbot settings: %w", err)
	}
	var set UserBotSettings
	if jerr := json.Unmarshal(raw, &set); jerr != nil {
		return UserBotSettings{}, jerr
	}
	set.IsConfigured = set.APIID > 0 && set.APIHash != "" && set.SessionString != ""
	return set, nil
}

// SetTelegramSettings stores the global UserBot credentials.
func (s *Store) SetTelegramSettings(ctx context.Context, set UserBotSettings, actorID string) error {
	b, err := json.Marshal(set)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `
		INSERT INTO app_settings (key, value, updated_at)
		VALUES ('telegram_userbot', $1::jsonb, now())
		ON CONFLICT (key) DO UPDATE
		SET value = EXCLUDED.value, updated_at = now();
	`, string(b))
	if err != nil {
		return fmt.Errorf("saving telegram userbot settings: %w", err)
	}
	if err := txAudit(ctx, tx, actorID, "settings.update_telegram_userbot", "settings", "telegram_userbot", map[string]any{
		"has_session": set.SessionString != "",
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListTelegramChannels returns all configured Telegram channels.
func (s *Store) ListTelegramChannels(ctx context.Context) ([]TelegramChannel, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, channel_id, password_script, created_at, updated_at
		FROM telegram_channels
		ORDER BY created_at DESC;
	`)
	if err != nil {
		return nil, fmt.Errorf("listing telegram channels: %w", err)
	}
	defer rows.Close()

	var items []TelegramChannel
	for rows.Next() {
		var c TelegramChannel
		if err := rows.Scan(&c.ID, &c.Name, &c.ChannelID, &c.PasswordScript, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, c)
	}
	if items == nil {
		items = []TelegramChannel{}
	}
	return items, rows.Err()
}

// GetTelegramChannel returns a single channel by ID.
func (s *Store) GetTelegramChannel(ctx context.Context, id string) (TelegramChannel, error) {
	var c TelegramChannel
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, channel_id, password_script, created_at, updated_at
		FROM telegram_channels
		WHERE id = $1;
	`, id).Scan(&c.ID, &c.Name, &c.ChannelID, &c.PasswordScript, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	if err != nil {
		return c, fmt.Errorf("loading telegram channel: %w", err)
	}
	return c, nil
}

// CreateTelegramChannel inserts a new channel configuration.
func (s *Store) CreateTelegramChannel(ctx context.Context, name, channelID, script, actorID string) (TelegramChannel, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TelegramChannel{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var c TelegramChannel
	err = tx.QueryRow(ctx, `
		INSERT INTO telegram_channels (name, channel_id, password_script)
		VALUES ($1, $2, $3)
		RETURNING id, name, channel_id, password_script, created_at, updated_at;
	`, strings.TrimSpace(name), strings.TrimSpace(channelID), script).Scan(
		&c.ID, &c.Name, &c.ChannelID, &c.PasswordScript, &c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return TelegramChannel{}, fmt.Errorf("inserting telegram channel: %w", err)
	}

	if err := txAudit(ctx, tx, actorID, "channel.created", "channel", c.ID, map[string]any{
		"name":       c.Name,
		"channel_id": c.ChannelID,
	}); err != nil {
		return TelegramChannel{}, err
	}

	return c, tx.Commit(ctx)
}

// UpdateTelegramChannel updates an existing channel configuration.
func (s *Store) UpdateTelegramChannel(ctx context.Context, id, name, channelID, script, actorID string) (TelegramChannel, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TelegramChannel{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var c TelegramChannel
	err = tx.QueryRow(ctx, `
		UPDATE telegram_channels
		SET name = $2, channel_id = $3, password_script = $4, updated_at = now()
		WHERE id = $1
		RETURNING id, name, channel_id, password_script, created_at, updated_at;
	`, id, strings.TrimSpace(name), strings.TrimSpace(channelID), script).Scan(
		&c.ID, &c.Name, &c.ChannelID, &c.PasswordScript, &c.CreatedAt, &c.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	if err != nil {
		return c, fmt.Errorf("updating telegram channel: %w", err)
	}

	if err := txAudit(ctx, tx, actorID, "channel.updated", "channel", c.ID, map[string]any{
		"name":       c.Name,
		"channel_id": c.ChannelID,
	}); err != nil {
		return TelegramChannel{}, err
	}

	return c, tx.Commit(ctx)
}

// DeleteTelegramChannel removes a channel.
func (s *Store) DeleteTelegramChannel(ctx context.Context, id, actorID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `DELETE FROM telegram_channels WHERE id = $1;`, id)
	if err != nil {
		return fmt.Errorf("deleting telegram channel: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}

	if err := txAudit(ctx, tx, actorID, "channel.deleted", "channel", id, map[string]any{"id": id}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// TelegramBlacklistItem represents a blacklisted channel message/archive.
type TelegramBlacklistItem struct {
	ID        string    `json:"id"`
	ChannelID string    `json:"channelId"`
	MessageID int64     `json:"messageId"`
	Filename  string    `json:"filename"`
	SHA256    string    `json:"sha256"`
	Reason    string    `json:"reason"`
	CreatedAt time.Time `json:"createdAt"`
}

// AddTelegramBlacklist records a bad password message to prevent repeated downloads.
func (s *Store) AddTelegramBlacklist(ctx context.Context, channelID string, messageID int64, filename, sha, reason string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO telegram_blacklist (channel_id, message_id, filename, sha256, reason)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (channel_id, message_id) DO UPDATE
		SET filename = EXCLUDED.filename, sha256 = EXCLUDED.sha256, reason = EXCLUDED.reason;
	`, strings.TrimSpace(channelID), messageID, strings.TrimSpace(filename), strings.TrimSpace(sha), reason)
	return err
}

// IsTelegramBlacklisted checks if a message ID or SHA256 has been marked as bad password.
func (s *Store) IsTelegramBlacklisted(ctx context.Context, channelID string, messageID int64, sha string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM telegram_blacklist
			WHERE (channel_id = $1 AND message_id = $2)
			   OR (sha256 = $3 AND $3 <> '')
		);
	`, strings.TrimSpace(channelID), messageID, strings.TrimSpace(sha)).Scan(&exists)
	return exists, err
}

// GetTelegramBlacklistMessageIDs returns a set of blacklisted message IDs for a channel.
func (s *Store) GetTelegramBlacklistMessageIDs(ctx context.Context, channelID string) (map[int64]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT message_id, reason
		FROM telegram_blacklist
		WHERE channel_id = $1;
	`, strings.TrimSpace(channelID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	m := make(map[int64]string)
	for rows.Next() {
		var mid int64
		var reason string
		if err := rows.Scan(&mid, &reason); err == nil {
			m[mid] = reason
		}
	}
	return m, rows.Err()
}

// ClearTelegramBlacklist removes blacklisted entries for a channel (or all if channelID is empty).
func (s *Store) ClearTelegramBlacklist(ctx context.Context, channelID string) error {
	if channelID == "" {
		_, err := s.pool.Exec(ctx, `DELETE FROM telegram_blacklist;`)
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM telegram_blacklist WHERE channel_id = $1;`, strings.TrimSpace(channelID))
	return err
}
