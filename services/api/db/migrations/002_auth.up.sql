BEGIN;
CREATE TABLE auth_email_state (
 email_key bytea PRIMARY KEY,
 last_requested_at timestamptz NOT NULL,
 pending_id text
);
CREATE TABLE auth_challenges (
 id text PRIMARY KEY,
 email text NOT NULL,
 email_key bytea NOT NULL,
 code_hash bytea NOT NULL CHECK(octet_length(code_hash)=32),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 delivered boolean NOT NULL DEFAULT false,
 consumed_at timestamptz
);
CREATE INDEX auth_challenges_email ON auth_challenges(email_key);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
CREATE TABLE auth_identities (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 email text NOT NULL UNIQUE
);
CREATE TABLE auth_sessions (
 token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE auth_rate_limits (
 key bytea PRIMARY KEY,
 window_start timestamptz NOT NULL,
 hits integer NOT NULL CHECK(hits>0)
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(window_start);
CREATE INDEX auth_email_state_expiry ON auth_email_state(last_requested_at);
COMMIT;
