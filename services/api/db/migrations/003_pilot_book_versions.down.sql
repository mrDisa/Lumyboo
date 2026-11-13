-- Refuse rollback if these editions still have reading data; never cascade it.
BEGIN;
DELETE FROM book_versions WHERE version='1' AND published_at IS NULL
 AND book_id IN ('room-for-stories','white-nights-excerpt','gambler-excerpt');
COMMIT;
