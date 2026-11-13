BEGIN;
CREATE INDEX reading_sessions_history ON reading_sessions(user_id, reported_day DESC, session_id DESC);
COMMIT;
