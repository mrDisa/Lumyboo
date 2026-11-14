BEGIN;
CREATE TABLE daily_goal_settings (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 time_zone text NOT NULL,
 revision bigint NOT NULL CHECK (revision > 0)
);
CREATE TABLE daily_goal_changes (
 user_id uuid NOT NULL REFERENCES daily_goal_settings(user_id) ON DELETE CASCADE,
 effective_from date NOT NULL,
 minutes integer NOT NULL CHECK (minutes IN (5,10,20,30,60)),
 PRIMARY KEY(user_id,effective_from)
);
COMMIT;
