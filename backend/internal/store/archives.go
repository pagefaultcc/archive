package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ArchiveItem is the JSON contract for one archive row.
type ArchiveItem struct {
	ID                string    `json:"id"`
	OwnerID           string    `json:"ownerId"`
	OwnerUsername     string    `json:"ownerUsername"`
	Filename          string    `json:"filename"`
	Format            string    `json:"format"`
	SizeBytes         int64     `json:"sizeBytes"`
	SHA256            string    `json:"sha256"`
	IsEncrypted       bool      `json:"isEncrypted"`
	Status            string    `json:"status"`
	FileCount         int       `json:"fileCount"`
	DirCount          int       `json:"dirCount"`
	UncompressedBytes int64     `json:"uncompressedBytes"`
	CreatedAt         time.Time `json:"createdAt"`
}

// ArchiveEntry is the JSON contract for one indexed archive member.
type ArchiveEntry struct {
	ID          int64      `json:"id"`
	Path        string     `json:"path"`
	ParentPath  string     `json:"parentPath"`
	Name        string     `json:"name"`
	IsDir       bool       `json:"isDir"`
	SizeBytes   int64      `json:"sizeBytes"`
	PackedBytes int64      `json:"packedBytes"`
	CRC32       string     `json:"crc32"`
	Encrypted   bool       `json:"encrypted"`
	ModifiedAt  *time.Time `json:"modifiedAt"`
}

// ArchiveDetail is the JSON contract for GET /api/archives/{id}.
type ArchiveDetail struct {
	Archive    ArchiveItem    `json:"archive"`
	Entries    []ArchiveEntry `json:"entries"`
	ParentPath string         `json:"parentPath"`
	Query      string         `json:"query"`
}

// IndexStats is the entry-count summary produced by indexing.
type IndexStats struct {
	FileCount         int
	DirCount          int
	UncompressedBytes int64
}

// EntryInput is the exported handle for handlers to insert entries.
type EntryInput = archiveEntryInput

// Stats summarizes indexed entries.
func (r IndexStats) Entries() int { return r.FileCount + r.DirCount }

// archiveEntryInput is one parsed entry to persist.
type archiveEntryInput struct {
	Path        string
	ParentPath  string
	Name        string
	IsDir       bool
	SizeBytes   int64
	PackedBytes int64
	CRC32       string
	Encrypted   bool
	ModifiedAt  *time.Time
}

// CreateArchiveInput carries everything needed to insert one archive.
type CreateArchiveInput struct {
	OwnerID         string
	Filename        string
	Format          string
	SizeBytes       int64
	SHA256          string
	IsEncrypted     bool
	ArchivePassword string
	Status          string
	StoragePath     string
	Entries         []archiveEntryInput
}

// NewEntryStats counts files, dirs, and total uncompressed size.
func NewEntryStats(entries []archiveEntryInput) IndexStats {
	var s IndexStats
	for _, e := range entries {
		if e.IsDir {
			s.DirCount++
			continue
		}
		s.FileCount++
		s.UncompressedBytes += e.SizeBytes
	}
	return s
}

// CreateArchive inserts an archives row plus all archive_entries rows and the
// archive.uploaded audit row in one transaction.
func (s *Store) CreateArchive(ctx context.Context, in CreateArchiveInput) (ArchiveItem, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("beginning archive insert: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	in.ArchivePassword = strings.Trim(strings.TrimSpace(in.ArchivePassword), "`'\"")
	stats := NewEntryStats(in.Entries)
	var id string
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO archives
			(owner_id, filename, format, size_bytes, sha256, is_encrypted, archive_password, status,
			 file_count, dir_count, uncompressed_bytes, storage_path)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		RETURNING id::text, created_at
	`, in.OwnerID, sanitizePGText(in.Filename), in.Format, in.SizeBytes, in.SHA256, in.IsEncrypted,
		sanitizePGText(in.ArchivePassword), in.Status, stats.FileCount, stats.DirCount,
		stats.UncompressedBytes, in.StoragePath).Scan(&id, &createdAt)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("inserting archive: %w", err)
	}

	if len(in.Entries) > 0 {
		if _, err := tx.CopyFrom(ctx,
			pgx.Identifier{"archive_entries"},
			[]string{"archive_id", "path", "parent_path", "name", "is_dir",
				"size_bytes", "packed_bytes", "crc32", "encrypted", "modified_at"},
			pgx.CopyFromSlice(len(in.Entries), func(i int) ([]any, error) {
				e := in.Entries[i]
				return []any{
					id,
					sanitizePGText(e.Path),
					sanitizePGText(e.ParentPath),
					sanitizePGText(e.Name),
					e.IsDir,
					e.SizeBytes,
					e.PackedBytes,
					sanitizePGText(e.CRC32),
					e.Encrypted,
					e.ModifiedAt,
				}, nil
			})); err != nil {
			return ArchiveItem{}, fmt.Errorf("inserting archive entries: %w", err)
		}
	}

	if err := txAudit(ctx, tx, in.OwnerID, "archive.uploaded", "archive", id,
		map[string]any{"filename": in.Filename, "format": in.Format,
			"status": in.Status, "size_bytes": in.SizeBytes}); err != nil {
		return ArchiveItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ArchiveItem{}, fmt.Errorf("committing archive insert: %w", err)
	}
	return s.GetArchive(ctx, id)
}

// GetArchive loads one archive item by ID.
func (s *Store) GetArchive(ctx context.Context, id string) (ArchiveItem, error) {
	row := s.pool.QueryRow(ctx, archiveSelect+` WHERE a.id = $1`, id)
	return scanArchive(row)
}

// GetArchiveBySHA256 checks if an archive with the exact same hash already exists.
func (s *Store) GetArchiveBySHA256(ctx context.Context, sha string) (ArchiveItem, bool, error) {
	row := s.pool.QueryRow(ctx, archiveSelect+` WHERE a.sha256 = $1 LIMIT 1`, sha)
	item, err := scanArchive(row)
	if errors.Is(err, ErrNotFound) {
		return ArchiveItem{}, false, nil
	}
	if err != nil {
		return ArchiveItem{}, false, err
	}
	return item, true, nil
}

// ListArchives returns all indexed archives ordered by created_at DESC, id DESC.
func (s *Store) ListArchives(ctx context.Context) ([]ArchiveItem, error) {
	rows, err := s.pool.Query(ctx, archiveSelect+` WHERE a.status = 'indexed' ORDER BY a.created_at DESC, a.id DESC`)
	if err != nil {
		return nil, fmt.Errorf("listing archives: %w", err)
	}
	defer rows.Close()
	items := []ArchiveItem{}
	for rows.Next() {
		item, err := scanArchive(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

const archiveSelect = `
	SELECT a.id::text, a.owner_id::text, COALESCE(u.username, ''),
	       a.filename, a.format, a.size_bytes, a.sha256, a.is_encrypted,
	       a.status, a.file_count, a.dir_count, a.uncompressed_bytes, a.created_at
	FROM archives a
	LEFT JOIN users u ON u.id = a.owner_id
`

type rowScanner interface{ Scan(dest ...any) error }

func scanArchive(row rowScanner) (ArchiveItem, error) {
	var a ArchiveItem
	err := row.Scan(&a.ID, &a.OwnerID, &a.OwnerUsername, &a.Filename, &a.Format,
		&a.SizeBytes, &a.SHA256, &a.IsEncrypted, &a.Status, &a.FileCount,
		&a.DirCount, &a.UncompressedBytes, &a.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ArchiveItem{}, ErrNotFound
	}
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("scanning archive: %w", err)
	}
	return a, nil
}

// GetArchiveDetail returns the archive plus its entries. When query is empty,
// entries are filtered to parentPath (tree browsing, "" = root). When query is
// non-empty, it is a case-insensitive substring search across all paths.
func (s *Store) GetArchiveDetail(ctx context.Context, id, parentPath, query string) (ArchiveDetail, error) {
	archive, err := s.GetArchive(ctx, id)
	if err != nil {
		return ArchiveDetail{}, err
	}

	var entries []ArchiveEntry
	if query != "" {
		escapedQuery := escapeLike(strings.ToLower(sanitizePGText(query)))
		rows, err := s.pool.Query(ctx, `
			SELECT id, path, parent_path, name, is_dir, size_bytes, packed_bytes,
			       crc32, encrypted, modified_at
			FROM archive_entries
			WHERE archive_id = $1 AND lower(path) LIKE '%' || $2 || '%' ESCAPE '\'
			ORDER BY path ASC
			LIMIT 1000
		`, id, escapedQuery)
		if err != nil {
			return ArchiveDetail{}, fmt.Errorf("searching archive entries: %w", err)
		}
		entries, err = collectArchiveEntries(rows)
		if err != nil {
			return ArchiveDetail{}, err
		}
	} else {
		rows, err := s.pool.Query(ctx, `
			SELECT id, path, parent_path, name, is_dir, size_bytes, packed_bytes,
			       crc32, encrypted, modified_at
			FROM archive_entries
			WHERE archive_id = $1 AND parent_path = $2
			ORDER BY is_dir DESC, name ASC
			LIMIT 1000
		`, id, parentPath)
		if err != nil {
			return ArchiveDetail{}, fmt.Errorf("browsing archive entries: %w", err)
		}
		entries, err = collectArchiveEntries(rows)
		if err != nil {
			return ArchiveDetail{}, err
		}
	}
	return ArchiveDetail{
		Archive:    archive,
		Entries:    entries,
		ParentPath: parentPath,
		Query:      query,
	}, nil
}

func collectArchiveEntries(rows pgx.Rows) ([]ArchiveEntry, error) {
	defer rows.Close()
	entries := []ArchiveEntry{}
	for rows.Next() {
		var e ArchiveEntry
		if err := rows.Scan(&e.ID, &e.Path, &e.ParentPath, &e.Name, &e.IsDir,
			&e.SizeBytes, &e.PackedBytes, &e.CRC32, &e.Encrypted, &e.ModifiedAt); err != nil {
			return nil, fmt.Errorf("scanning archive entry: %w", err)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// GetArchiveForUnlock loads the storage path and format for password
// verification and reindexing.
func (s *Store) GetArchiveForUnlock(ctx context.Context, id string) (storagePath, format, status string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT storage_path, format, status FROM archives WHERE id = $1
	`, id).Scan(&storagePath, &format, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	if err != nil {
		return "", "", "", fmt.Errorf("loading archive for unlock: %w", err)
	}
	return storagePath, format, status, nil
}

// UnlockArchive replaces the entries of a previously password_required archive
// with the freshly indexed rows, marks it indexed, and writes the
// archive.unlocked audit row in one transaction.
func (s *Store) UnlockArchive(ctx context.Context, id, actorID, archivePassword string, entries []archiveEntryInput) (ArchiveItem, error) {
	archivePassword = strings.Trim(strings.TrimSpace(archivePassword), "`'\"")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("beginning archive unlock: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	stats := NewEntryStats(entries)
	tag, err := tx.Exec(ctx, `
		UPDATE archives
		SET status = 'indexed', file_count = $2, dir_count = $3,
		    uncompressed_bytes = $4, archive_password = $5
		WHERE id = $1
	`, id, stats.FileCount, stats.DirCount, stats.UncompressedBytes, archivePassword)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("updating archive status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ArchiveItem{}, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `DELETE FROM archive_entries WHERE archive_id = $1`, id); err != nil {
		return ArchiveItem{}, fmt.Errorf("clearing archive entries: %w", err)
	}
	if len(entries) > 0 {
		if _, err := tx.CopyFrom(ctx,
			pgx.Identifier{"archive_entries"},
			[]string{"archive_id", "path", "parent_path", "name", "is_dir",
				"size_bytes", "packed_bytes", "crc32", "encrypted", "modified_at"},
			pgx.CopyFromSlice(len(entries), func(i int) ([]any, error) {
				e := entries[i]
				return []any{
					id,
					sanitizePGText(e.Path),
					sanitizePGText(e.ParentPath),
					sanitizePGText(e.Name),
					e.IsDir,
					e.SizeBytes,
					e.PackedBytes,
					sanitizePGText(e.CRC32),
					e.Encrypted,
					e.ModifiedAt,
				}, nil
			})); err != nil {
			return ArchiveItem{}, fmt.Errorf("inserting archive entries: %w", err)
		}
	}
	if err := txAudit(ctx, tx, actorID, "archive.unlocked", "archive", id,
		map[string]any{"file_count": stats.FileCount, "dir_count": stats.DirCount}); err != nil {
		return ArchiveItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ArchiveItem{}, fmt.Errorf("committing archive unlock: %w", err)
	}
	return s.GetArchive(ctx, id)
}

// MarkArchiveDeleting marks an archive as deleting so it is immediately omitted from listings.
func (s *Store) MarkArchiveDeleting(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE archives SET status = 'deleting' WHERE id = $1`, id)
	return err
}

// DeleteArchive removes the archives row (cascading entries), deletes the
// stored file, and writes the archive.deleted audit row in one transaction.
func (s *Store) DeleteArchive(ctx context.Context, id, actorID string) (storagePath string, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("beginning archive delete: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var path string
	err = tx.QueryRow(ctx, `SELECT storage_path FROM archives WHERE id = $1`, id).Scan(&path)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("loading archive for delete: %w", err)
	}

	// Direct indexed deletes inside the transaction
	if _, err := tx.Exec(ctx, `DELETE FROM archive_cookie_domains WHERE archive_id = $1`, id); err != nil {
		return "", fmt.Errorf("deleting archive cookie domains: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM archive_credentials WHERE archive_id = $1`, id); err != nil {
		return "", fmt.Errorf("deleting archive credentials: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM archive_entries WHERE archive_id = $1`, id); err != nil {
		return "", fmt.Errorf("deleting archive entries: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM archives WHERE id = $1`, id); err != nil {
		return "", fmt.Errorf("deleting archive: %w", err)
	}
	if err := txAudit(ctx, tx, actorID, "archive.deleted", "archive", id,
		map[string]any{"filename": path}); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("committing archive delete: %w", err)
	}
	s.InvalidateCookieCache()
	return path, nil
}

// HasArchiveWithStoragePath reports whether any archive row still references storagePath.
func (s *Store) HasArchiveWithStoragePath(ctx context.Context, storagePath string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM archives WHERE storage_path = $1)`, storagePath).Scan(&exists)
	return exists, err
}

// SetArchivePassword updates the stored archive_password for an archive.
func (s *Store) SetArchivePassword(ctx context.Context, id, password string) error {
	password = sanitizePGText(strings.Trim(strings.TrimSpace(password), "`'\""))
	_, err := s.pool.Exec(ctx, `UPDATE archives SET archive_password = $2 WHERE id = $1`, id, password)
	return err
}

// GetArchiveEntryForRead resolves one indexed entry by path along with the
// parent archive's filename, storage_path, format, and stored archive_password.
func (s *Store) GetArchiveEntryForRead(
	ctx context.Context,
	archiveID, entryPath string,
) (archiveFilename, storagePath, format, archivePassword string, entry ArchiveEntry, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT a.filename, a.storage_path, a.format, a.archive_password,
		       e.id, e.path, e.parent_path, e.name, e.is_dir,
		       e.size_bytes, e.packed_bytes, e.crc32, e.encrypted, e.modified_at
		FROM archives a
		JOIN archive_entries e ON e.archive_id = a.id
		WHERE a.id = $1 AND lower(e.path) = lower($2)
	`, archiveID, entryPath).Scan(
		&archiveFilename, &storagePath, &format, &archivePassword,
		&entry.ID, &entry.Path, &entry.ParentPath, &entry.Name, &entry.IsDir,
		&entry.SizeBytes, &entry.PackedBytes, &entry.CRC32, &entry.Encrypted, &entry.ModifiedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", "", ArchiveEntry{}, ErrNotFound
	}
	if err != nil {
		return "", "", "", "", ArchiveEntry{}, fmt.Errorf("loading archive entry: %w", err)
	}
	return archiveFilename, storagePath, format, archivePassword, entry, nil
}

// ArchiveRecord holds minimal archive metadata for reindexing.
type ArchiveRecord struct {
	ID              string
	Filename        string
	Format          string
	StoragePath     string
	ArchivePassword string
	IsEncrypted     bool
}

// GetAllArchivesForReindex loads all archive rows to re-run indexing.
func (s *Store) GetAllArchivesForReindex(ctx context.Context) ([]ArchiveRecord, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, filename, format, storage_path, archive_password, is_encrypted
		FROM archives
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("querying archives for reindex: %w", err)
	}
	defer rows.Close()

	var records []ArchiveRecord
	for rows.Next() {
		var r ArchiveRecord
		if err := rows.Scan(&r.ID, &r.Filename, &r.Format, &r.StoragePath, &r.ArchivePassword, &r.IsEncrypted); err != nil {
			return nil, err
		}
		records = append(records, r)
	}
	return records, rows.Err()
}

// GetArchiveForReindex loads a single archive row for reindexing.
func (s *Store) GetArchiveForReindex(ctx context.Context, id string) (ArchiveRecord, error) {
	var r ArchiveRecord
	err := s.pool.QueryRow(ctx, `
		SELECT id, filename, format, storage_path, archive_password, is_encrypted
		FROM archives
		WHERE id = $1
	`, id).Scan(&r.ID, &r.Filename, &r.Format, &r.StoragePath, &r.ArchivePassword, &r.IsEncrypted)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, fmt.Errorf("loading archive for reindex: %w", err)
	}
	return r, nil
}

// ApplyReindexedEntries updates the archive status, counts, and replaces all entries in one transaction.
func (s *Store) ApplyReindexedEntries(
	ctx context.Context,
	id, actorID string,
	entries []archiveEntryInput,
	status string,
) (ArchiveItem, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("beginning archive reindex transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	stats := NewEntryStats(entries)
	tag, err := tx.Exec(ctx, `
		UPDATE archives
		SET status = $2, file_count = $3, dir_count = $4,
		    uncompressed_bytes = $5
		WHERE id = $1
	`, id, status, stats.FileCount, stats.DirCount, stats.UncompressedBytes)
	if err != nil {
		return ArchiveItem{}, fmt.Errorf("updating archive status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ArchiveItem{}, ErrNotFound
	}

	if _, err := tx.Exec(ctx, `DELETE FROM archive_entries WHERE archive_id = $1`, id); err != nil {
		return ArchiveItem{}, fmt.Errorf("clearing archive entries: %w", err)
	}

	if len(entries) > 0 {
		if _, err := tx.CopyFrom(ctx,
			pgx.Identifier{"archive_entries"},
			[]string{"archive_id", "path", "parent_path", "name", "is_dir",
				"size_bytes", "packed_bytes", "crc32", "encrypted", "modified_at"},
			pgx.CopyFromSlice(len(entries), func(i int) ([]any, error) {
				e := entries[i]
				return []any{
					id,
					sanitizePGText(e.Path),
					sanitizePGText(e.ParentPath),
					sanitizePGText(e.Name),
					e.IsDir,
					e.SizeBytes,
					e.PackedBytes,
					sanitizePGText(e.CRC32),
					e.Encrypted,
					e.ModifiedAt,
				}, nil
			})); err != nil {
			return ArchiveItem{}, fmt.Errorf("inserting reindexed entries: %w", err)
		}
	}

	if err := txAudit(ctx, tx, actorID, "archive.reindexed", "archive", id,
		map[string]any{"file_count": stats.FileCount, "dir_count": stats.DirCount, "status": status}); err != nil {
		return ArchiveItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ArchiveItem{}, fmt.Errorf("committing archive reindex: %w", err)
	}
	return s.GetArchive(ctx, id)
}

// GetExistingArchivesMap returns a map from lowercase filename to all known size_bytes in the vault.
func (s *Store) GetExistingArchivesMap(ctx context.Context) (map[string][]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT lower(filename), size_bytes FROM archives;`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string][]int64)
	for rows.Next() {
		var fn string
		var sz int64
		if err := rows.Scan(&fn, &sz); err == nil {
			cleanFn := strings.ToLower(strings.TrimSpace(fn))
			m[cleanFn] = append(m[cleanFn], sz)
		}
	}
	return m, rows.Err()
}

// IsArchived reports whether an archive with matching filename and size exists in the vault.
// If sizeBytes <= 0, it falls back to checking filename existence.
func IsArchived(existingMap map[string][]int64, filename string, sizeBytes int64) bool {
	if existingMap == nil {
		return false
	}
	cleanFn := strings.ToLower(strings.TrimSpace(filename))
	sizes, exists := existingMap[cleanFn]
	if !exists {
		return false
	}
	if sizeBytes <= 0 {
		return true
	}
	for _, sz := range sizes {
		if sz == sizeBytes {
			return true
		}
	}
	return false
}

// GetExistingArchiveFilenames returns a set of all lowercase filenames currently in the archives table.
func (s *Store) GetExistingArchiveFilenames(ctx context.Context) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT lower(filename) FROM archives;`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]bool)
	for rows.Next() {
		var fn string
		if err := rows.Scan(&fn); err == nil {
			m[strings.ToLower(strings.TrimSpace(fn))] = true
		}
	}
	return m, rows.Err()
}
