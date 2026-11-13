BEGIN;
ALTER TABLE bookmarks DROP COLUMN server_revision;
COMMIT;
