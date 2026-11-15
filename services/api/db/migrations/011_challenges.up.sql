BEGIN;
CREATE TABLE challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
 mode text NOT NULL CHECK (mode IN ('competitive','personal')),
 start_day date NOT NULL,
 duration integer NOT NULL CHECK (duration IN (7,14,30)),
 time_zone text NOT NULL,
 minutes integer NOT NULL CHECK (minutes IN (5,10,20,30,60)),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,operation_id)
);
CREATE INDEX challenges_owner_created ON challenges(owner_id,created_at DESC,id);
CREATE TABLE challenge_members (
 challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 40),
 minutes integer NOT NULL CHECK (minutes IN (5,10,20,30,60)),
 joined_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(challenge_id,user_id)
);
COMMIT;
