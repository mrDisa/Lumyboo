BEGIN;
-- Unverified cumulative client reports, not credited days, completion or rewards.
CREATE TABLE reading_sessions (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL,
 device_id uuid NOT NULL,
 book_id text NOT NULL,
 book_version text NOT NULL,
 reported_day date NOT NULL CHECK (reported_day BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 milliseconds bigint NOT NULL CHECK (milliseconds BETWEEN 1 AND 86400000),
 server_revision bigint NOT NULL CHECK (server_revision BETWEEN 1 AND 86400000),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,session_id),
 FOREIGN KEY(book_id,book_version) REFERENCES book_versions(book_id,version)
);
COMMIT;
