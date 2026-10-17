package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// StorageTypeStat represents size and count for a file extension.
type StorageTypeStat struct {
	Extension string `json:"extension"`
	Count     int64  `json:"count"`
	SizeBytes int64  `json:"sizeBytes"`
}

// StorageFormatStat represents count and packed size for an archive format.
type StorageFormatStat struct {
	Format    string `json:"format"`
	Count     int64  `json:"count"`
	SizeBytes int64  `json:"sizeBytes"`
}

// ArchiveSizeBreakdown represents one uploaded archive's storage vs uncompressed footprint.
type ArchiveSizeBreakdown struct {
	ID                string `json:"id"`
	Filename          string `json:"filename"`
	Format            string `json:"format"`
	PackedBytes       int64  `json:"packedBytes"`
	UncompressedBytes int64  `json:"uncompressedBytes"`
	FileCount         int    `json:"fileCount"`
	DirCount          int    `json:"dirCount"`
	Ratio             string `json:"ratio"`
}

// GlobalStorageStats captures overall storage and indexing metrics across the platform.
type GlobalStorageStats struct {
	TotalArchives          int64                  `json:"totalArchives"`
	TotalPackedBytes       int64                  `json:"totalPackedBytes"`
	TotalUncompressedBytes int64                  `json:"totalUncompressedBytes"`
	TotalFiles             int64                  `json:"totalFiles"`
	TotalDirs              int64                  `json:"totalDirs"`
	EncryptedVaults        int64                  `json:"encryptedVaults"`
	DiskTotalBytes         uint64                 `json:"diskTotalBytes"`
	DiskFreeBytes          uint64                 `json:"diskFreeBytes"`
	DiskUsedBytes          uint64                 `json:"diskUsedBytes"`
	FormatDistribution     []StorageFormatStat    `json:"formatDistribution"`
	ArchiveBreakdown       []ArchiveSizeBreakdown `json:"archiveBreakdown"`
}

// GetGlobalStorageStats calculates comprehensive metrics across all archives and the host disk.
func (s *Store) GetGlobalStorageStats(ctx context.Context, storageDir string) (GlobalStorageStats, error) {
	var stats GlobalStorageStats
	err := s.pool.QueryRow(ctx, `
		SELECT 
			count(*),
			coalesce(sum(size_bytes), 0),
			coalesce(sum(uncompressed_bytes), 0),
			coalesce(sum(file_count), 0),
			coalesce(sum(dir_count), 0),
			coalesce(count(*) FILTER (WHERE is_encrypted = true), 0)
		FROM archives;
	`).Scan(
		&stats.TotalArchives,
		&stats.TotalPackedBytes,
		&stats.TotalUncompressedBytes,
		&stats.TotalFiles,
		&stats.TotalDirs,
		&stats.EncryptedVaults,
	)
	if err != nil {
		return stats, fmt.Errorf("querying storage totals: %w", err)
	}

	fRows, err := s.pool.Query(ctx, `
		SELECT format, count(*), coalesce(sum(size_bytes), 0)
		FROM archives
		GROUP BY format
		ORDER BY count(*) DESC;
	`)
	if err == nil {
		defer fRows.Close()
		for fRows.Next() {
			var f StorageFormatStat
			if err := fRows.Scan(&f.Format, &f.Count, &f.SizeBytes); err == nil {
				stats.FormatDistribution = append(stats.FormatDistribution, f)
			}
		}
	}

	bRows, err := s.pool.Query(ctx, `
		SELECT 
			id, filename, format, size_bytes, uncompressed_bytes, file_count, dir_count,
			to_char(round((uncompressed_bytes::numeric / NULLIF(size_bytes, 0)), 2), 'FM990.09') || 'x' AS ratio
		FROM archives
		ORDER BY size_bytes DESC
		LIMIT 50;
	`)
	if err == nil {
		defer bRows.Close()
		for bRows.Next() {
			var b ArchiveSizeBreakdown
			if err := bRows.Scan(&b.ID, &b.Filename, &b.Format, &b.PackedBytes, &b.UncompressedBytes, &b.FileCount, &b.DirCount, &b.Ratio); err == nil {
				stats.ArchiveBreakdown = append(stats.ArchiveBreakdown, b)
			}
		}
	}

	return stats, nil
}

// GetArchivePasswords loads the user-configured archive password dictionary from app_settings.
func (s *Store) GetArchivePasswords(ctx context.Context) ([]string, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `
		SELECT value::text FROM app_settings WHERE key = 'archive_passwords';
	`).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("loading archive passwords: %w", err)
	}
	var pws []string
	if jerr := json.Unmarshal(raw, &pws); jerr != nil {
		return nil, fmt.Errorf("decoding archive passwords: %w", jerr)
	}
	return pws, nil
}

// SetArchivePasswords persists the updated archive password dictionary into app_settings.
func (s *Store) SetArchivePasswords(ctx context.Context, pws []string, actorID string) error {
	seen := make(map[string]bool)
	var clean []string
	for _, p := range pws {
		t := strings.TrimSpace(p)
		if t != "" && !seen[t] {
			seen[t] = true
			clean = append(clean, t)
		}
	}
	b, err := json.Marshal(clean)
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
		VALUES ('archive_passwords', $1::jsonb, now())
		ON CONFLICT (key) DO UPDATE
		SET value = EXCLUDED.value, updated_at = now();
	`, string(b))
	if err != nil {
		return fmt.Errorf("saving archive passwords: %w", err)
	}
	if err := txAudit(ctx, tx, actorID, "settings.update_archive_passwords", "settings", "archive_passwords", map[string]any{
		"password_count": len(clean),
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
