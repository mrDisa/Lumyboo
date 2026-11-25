-- Foreign keys refuse rollback when reading data references these editions.
BEGIN;
DELETE FROM book_versions WHERE book_id='diary-of-madman' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='asya' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='first-love' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='mumu' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='death-of-ivan-ilyich' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='kreutzer-sonata' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='after-the-ball' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='lady-with-dog' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='ionych' AND version='1' AND published_at IS NULL;
COMMIT;
