-- Foreign keys refuse rollback when reading data references these editions.
BEGIN;
DELETE FROM book_versions WHERE book_id='overcoat' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='nose' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='nevsky-prospect' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='portrait' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='gambler' AND version='1' AND published_at IS NULL;
COMMIT;
