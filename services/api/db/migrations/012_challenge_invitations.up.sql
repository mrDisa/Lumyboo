BEGIN;
ALTER TABLE challenge_members ADD COLUMN left_at timestamptz;
CREATE TABLE challenge_invitations (
 code text PRIMARY KEY,
 challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
 revoked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX challenge_one_active_invitation ON challenge_invitations(challenge_id) WHERE NOT revoked;
CREATE INDEX challenge_members_user ON challenge_members(user_id,challenge_id);
COMMIT;
