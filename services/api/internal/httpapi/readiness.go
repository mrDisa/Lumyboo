package httpapi

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresReadiness checks the schema used by the running account API, not just
// the connection. LIMIT 0 verifies relations, columns and SELECT permissions
// without reading private rows. It never applies migrations on a live request.
type PostgresReadiness struct{ Pool *pgxpool.Pool }

func (p PostgresReadiness) Ping(ctx context.Context) error {
	_, err := p.Pool.Exec(ctx, `
 SELECT id, deleted_at FROM users LIMIT 0;
 SELECT email_key, last_requested_at, pending_id FROM auth_email_state LIMIT 0;
 SELECT id, email, email_key, code_hash, created_at, expires_at, attempts, delivered, consumed_at FROM auth_challenges LIMIT 0;
 SELECT user_id, email FROM auth_identities LIMIT 0;
 SELECT token_hash, user_id, created_at, expires_at, revoked_at FROM auth_sessions LIMIT 0;
 SELECT key, window_start, hits FROM auth_rate_limits LIMIT 0;
 SELECT book_id, version FROM book_versions LIMIT 0;
 SELECT user_id, book_id FROM shelf LIMIT 0;
 SELECT user_id, book_id, book_version, locator, server_revision, updated_at FROM reading_positions LIMIT 0;
 SELECT user_id, book_id, book_version, locator, server_revision, recorded_at FROM reading_position_history LIMIT 0;
 SELECT id, user_id, book_id, book_version, locator, server_revision, deleted_at FROM bookmarks LIMIT 0;
 SELECT user_id, operation_id, result FROM processed_operations LIMIT 0;
 SELECT id,owner_id,operation_id,request_hash,name,mode,start_day,duration,time_zone,minutes,created_at FROM challenges LIMIT 0;
 SELECT challenge_id,user_id,nickname,minutes,joined_at,left_at,days_at_exit FROM challenge_members LIMIT 0;
 SELECT code,challenge_id,revoked,created_at FROM challenge_invitations LIMIT 0;
 SELECT user_id,time_zone,revision FROM daily_goal_settings LIMIT 0;
 SELECT user_id,effective_from,minutes FROM daily_goal_changes LIMIT 0;
 SELECT user_id, session_id, device_id, book_id, book_version, reported_day, milliseconds, server_revision, created_at, updated_at FROM reading_sessions LIMIT 0;
 SELECT user_id, book_id, book_version, paragraph, ranges, updated_at FROM reading_coverage LIMIT 0;
 `)
	return err
}
