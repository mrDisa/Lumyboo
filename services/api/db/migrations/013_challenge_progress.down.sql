BEGIN;
ALTER TABLE challenge_members DROP COLUMN days_at_exit;
COMMIT;
