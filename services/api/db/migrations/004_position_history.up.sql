BEGIN;
CREATE TABLE reading_position_history (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 book_id text NOT NULL,
 book_version text NOT NULL,
 locator jsonb NOT NULL,
 server_revision bigint NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,book_id,server_revision),
 FOREIGN KEY(book_id,book_version) REFERENCES book_versions(book_id,version)
);
COMMIT;
