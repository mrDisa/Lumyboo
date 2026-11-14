-- Refuse rollback while reading data references this edition; never cascade.
BEGIN;
DELETE FROM book_versions WHERE book_id='what-men-live-by' AND version='1' AND published_at IS NULL;
COMMIT;
