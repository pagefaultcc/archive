-- +goose Up
CREATE TABLE archives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('zip', '7z', 'rar')),
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL,
    is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'indexed'
        CHECK (status IN ('indexed', 'password_required', 'failed')),
    file_count INT NOT NULL DEFAULT 0,
    dir_count INT NOT NULL DEFAULT 0,
    uncompressed_bytes BIGINT NOT NULL DEFAULT 0,
    storage_path TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX archives_created_at_idx ON archives (created_at DESC, id DESC);
CREATE INDEX archives_owner_id_idx ON archives (owner_id);

CREATE TABLE archive_entries (
    id BIGSERIAL PRIMARY KEY,
    archive_id UUID NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    parent_path TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    is_dir BOOLEAN NOT NULL DEFAULT FALSE,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    packed_bytes BIGINT NOT NULL DEFAULT 0,
    crc32 TEXT NOT NULL DEFAULT '',
    encrypted BOOLEAN NOT NULL DEFAULT FALSE,
    modified_at TIMESTAMPTZ
);

CREATE INDEX archive_entries_browse_idx
    ON archive_entries (archive_id, parent_path, is_dir DESC, name ASC);
CREATE INDEX archive_entries_search_idx
    ON archive_entries (archive_id, lower(path));

INSERT INTO permissions (name, label) VALUES
    ('archives:read', 'Read and browse archives'),
    ('archives:upload', 'Upload and index archives'),
    ('archives:delete', 'Delete archives');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.name IN ('archives:read', 'archives:upload', 'archives:delete')
WHERE r.name = 'root';

-- +goose Down
DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions WHERE name IN ('archives:read', 'archives:upload', 'archives:delete')
);
DELETE FROM permissions WHERE name IN ('archives:read', 'archives:upload', 'archives:delete');
DROP TABLE IF EXISTS archive_entries;
DROP TABLE IF EXISTS archives;
