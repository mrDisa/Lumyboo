-- Foreign keys refuse rollback when reading data references this edition.
BEGIN;
DELETE FROM book_versions WHERE book_id='ward-no-6' AND version='1' AND published_at IS NULL;
COMMIT;
