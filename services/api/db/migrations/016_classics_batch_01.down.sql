-- Foreign keys refuse rollback when reading data references these editions.
BEGIN;
DELETE FROM book_versions WHERE book_id='stationmaster' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='blizzard' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='shot' AND version='1' AND published_at IS NULL;
DELETE FROM book_versions WHERE book_id='squires-daughter' AND version='1' AND published_at IS NULL;
COMMIT;
