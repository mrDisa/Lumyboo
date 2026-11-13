-- Initial schema only. No production users are provisioned by this migration.
BEGIN;
CREATE TABLE users (
 id uuid PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz
);
CREATE TABLE book_versions (
 book_id text NOT NULL,
 version text NOT NULL,
 title text NOT NULL,
 author text NOT NULL,
 genre text NOT NULL,
 rights_status text NOT NULL CHECK (rights_status IN ('pending','approved','blocked','development_fixture')),
 rights_basis text NOT NULL,
 age_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
 content_hash text NOT NULL,
 object_key text NOT NULL,
 published_at timestamptz,
 PRIMARY KEY(book_id,version),
 CHECK(published_at IS NULL OR rights_status='approved')
);
CREATE TABLE user_settings (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 theme text NOT NULL DEFAULT 'system' CHECK(theme IN ('light','dark','system')),
 reader_settings jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE shelf (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 book_id text NOT NULL,
 PRIMARY KEY(user_id,book_id)
);
CREATE TABLE reading_positions (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 book_id text NOT NULL,
 book_version text NOT NULL,
 locator jsonb NOT NULL,
 server_revision bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,book_id),
 FOREIGN KEY(book_id,book_version) REFERENCES book_versions(book_id,version)
);
CREATE TABLE bookmarks (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 book_id text NOT NULL,
 book_version text NOT NULL,
 locator jsonb NOT NULL,
 deleted_at timestamptz,
 FOREIGN KEY(book_id,book_version) REFERENCES book_versions(book_id,version)
);
CREATE INDEX bookmarks_owner ON bookmarks(user_id);
CREATE TABLE processed_operations (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,operation_id)
);
COMMIT;
