BEGIN;
DROP TABLE challenge_invitations;
DROP INDEX challenge_members_user;
ALTER TABLE challenge_members DROP COLUMN left_at;
COMMIT;
