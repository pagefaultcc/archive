-- +goose Up
ALTER TABLE users
    ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended')),
    ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE roles
    ADD COLUMN protected BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE roles SET protected = TRUE WHERE name IN ('root', 'user');

-- Additional session identifier for the session-management API. The raw
-- token and its digest remain secret; this UUID is safe to expose.
ALTER TABLE sessions
    ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX sessions_id_key ON sessions (id);

CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at);
CREATE INDEX audit_logs_actor_id_idx ON audit_logs (actor_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);

-- audit_logs is append-only at the database level.
-- +goose StatementBegin
CREATE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER audit_logs_no_update
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

INSERT INTO permissions (name, label) VALUES
    ('users:update', 'Update users'),
    ('users:delete', 'Delete users'),
    ('users:manage_roles', 'Manage user roles'),
    ('users:manage_sessions', 'Manage user sessions'),
    ('roles:read', 'Read roles'),
    ('roles:create', 'Create roles'),
    ('roles:update', 'Update roles'),
    ('roles:delete', 'Delete roles'),
    ('audit:read', 'Read audit log');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.name LIKE 'users:%' OR p.name LIKE 'roles:%' OR p.name = 'audit:read'
WHERE r.name = 'root'
ON CONFLICT DO NOTHING;

-- +goose Down
DROP TRIGGER audit_logs_no_update ON audit_logs;
DROP FUNCTION audit_logs_append_only();
DROP TABLE audit_logs;
DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE name NOT IN ('users:read', 'users:create'));
DELETE FROM permissions WHERE name NOT IN ('users:read', 'users:create');
DROP INDEX sessions_id_key;
ALTER TABLE sessions DROP COLUMN id;
ALTER TABLE roles DROP COLUMN protected;
ALTER TABLE users
    DROP COLUMN deleted_at,
    DROP COLUMN status;
