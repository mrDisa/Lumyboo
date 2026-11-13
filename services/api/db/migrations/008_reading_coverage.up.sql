BEGIN;
-- Geometric observations; no completion, credited time or rewards inferred.
CREATE TABLE reading_coverage (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 book_id text NOT NULL,
 book_version text NOT NULL,
 paragraph text COLLATE "C" NOT NULL CHECK (length(paragraph) BETWEEN 1 AND 200),
 ranges jsonb NOT NULL CHECK (jsonb_typeof(ranges) = 'array' AND jsonb_array_length(ranges) BETWEEN 1 AND 256),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,book_id,book_version,paragraph),
 FOREIGN KEY(book_id,book_version) REFERENCES book_versions(book_id,version)
);
COMMIT;
