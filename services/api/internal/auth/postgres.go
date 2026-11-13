package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Postgres struct{ pool *pgxpool.Pool }

func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{pool: pool} }
func commitError(ctx context.Context, tx pgx.Tx, cause error) error {
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return cause
}
func takeRate(ctx context.Context, tx pgx.Tx, key []byte, now time.Time, period time.Duration, limit int) error {
	var hits int
	err := tx.QueryRow(ctx, `INSERT INTO auth_rate_limits(key,window_start,hits) VALUES($1,$2,1)
 ON CONFLICT(key) DO UPDATE SET window_start=CASE WHEN auth_rate_limits.window_start<=$3 THEN $2 ELSE auth_rate_limits.window_start END,
 hits=CASE WHEN auth_rate_limits.window_start<=$3 THEN 1 ELSE auth_rate_limits.hits+1 END
 WHERE auth_rate_limits.window_start<=$3 OR auth_rate_limits.hits<$4 RETURNING hits`, key, now, now.Add(-period), limit).Scan(&hits)
	if errors.Is(err, pgx.ErrNoRows) {
		var start time.Time
		if e := tx.QueryRow(ctx, `SELECT window_start FROM auth_rate_limits WHERE key=$1`, key).Scan(&start); e != nil {
			return e
		}
		return &RateError{RetryAfter: max(1, int(math.Ceil(start.Add(period).Sub(now).Seconds())))}
	}
	return err
}
func (p *Postgres) Create(ctx context.Context, c Challenge) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = takeRate(ctx, tx, c.IPKey, c.CreatedAt, time.Hour, 20); err != nil {
		if errors.Is(err, ErrRateLimited) {
			return commitError(ctx, tx, err)
		}
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO auth_email_state(email_key,last_requested_at) VALUES($1,'epoch') ON CONFLICT DO NOTHING`, c.EmailKey); err != nil {
		return err
	}
	var last time.Time
	if err = tx.QueryRow(ctx, `SELECT last_requested_at FROM auth_email_state WHERE email_key=$1 FOR UPDATE`, c.EmailKey).Scan(&last); err != nil {
		return err
	}
	if c.CreatedAt.Sub(last) < ResendDelay {
		return commitError(ctx, tx, &RateError{RetryAfter: max(1, int(math.Ceil(last.Add(ResendDelay).Sub(c.CreatedAt).Seconds())))})
	}
	if err = takeRate(ctx, tx, c.EmailKey, c.CreatedAt, time.Hour, 5); err != nil {
		if errors.Is(err, ErrRateLimited) {
			return commitError(ctx, tx, err)
		}
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO auth_challenges(id,email,email_key,code_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, c.ID, c.Email, c.EmailKey, c.CodeHash, c.CreatedAt, c.ExpiresAt); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE auth_email_state SET last_requested_at=$2,pending_id=$3 WHERE email_key=$1`, c.EmailKey, c.CreatedAt, c.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (p *Postgres) Delivered(ctx context.Context, id string, now time.Time) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var key []byte
	if err = tx.QueryRow(ctx, `SELECT email_key FROM auth_challenges WHERE id=$1`, id).Scan(&key); err != nil {
		return err
	}
	var pending *string
	if err = tx.QueryRow(ctx, `SELECT pending_id FROM auth_email_state WHERE email_key=$1 FOR UPDATE`, key).Scan(&pending); err != nil {
		return err
	}
	if pending == nil || *pending != id {
		return ErrDelivery
	}
	result, err := tx.Exec(ctx, `UPDATE auth_challenges SET delivered=true WHERE id=$1 AND expires_at>$2`, id, now)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrDelivery
	}
	if _, err = tx.Exec(ctx, `DELETE FROM auth_challenges WHERE email_key=$1 AND id<>$2`, key, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (p *Postgres) Cancel(ctx context.Context, id string) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM auth_challenges WHERE id=$1 AND NOT delivered`, id)
	return err
}
func (p *Postgres) Consume(ctx context.Context, a Attempt) (User, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback(ctx)
	if err = takeRate(ctx, tx, a.IPKey, a.Now, 10*time.Minute, 100); err != nil {
		if errors.Is(err, ErrRateLimited) {
			return User{}, commitError(ctx, tx, err)
		}
		return User{}, err
	}
	var key []byte
	err = tx.QueryRow(ctx, `SELECT email_key FROM auth_challenges WHERE id=$1`, a.ChallengeID).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, commitError(ctx, tx, ErrInvalidCode)
	}
	if err != nil {
		return User{}, err
	}
	if _, err = tx.Exec(ctx, `SELECT email_key FROM auth_email_state WHERE email_key=$1 FOR UPDATE`, key); err != nil {
		return User{}, err
	}
	var email string
	var hash []byte
	var expires time.Time
	var attempts int
	var delivered bool
	var consumed *time.Time
	err = tx.QueryRow(ctx, `SELECT email,code_hash,expires_at,attempts,delivered,consumed_at FROM auth_challenges WHERE id=$1 FOR UPDATE`, a.ChallengeID).Scan(&email, &hash, &expires, &attempts, &delivered, &consumed)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, commitError(ctx, tx, ErrInvalidCode)
	}
	if err != nil {
		return User{}, err
	}
	if !delivered || consumed != nil || !a.Now.Before(expires) || attempts >= 5 {
		return User{}, commitError(ctx, tx, ErrInvalidCode)
	}
	if subtle.ConstantTimeCompare(hash, a.CodeHash) != 1 {
		if _, err = tx.Exec(ctx, `UPDATE auth_challenges SET attempts=attempts+1 WHERE id=$1`, a.ChallengeID); err != nil {
			return User{}, err
		}
		return User{}, commitError(ctx, tx, ErrInvalidCode)
	}
	var userID string
	err = tx.QueryRow(ctx, `SELECT user_id::text FROM auth_identities WHERE email=$1`, email).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		userID = a.NewUserID
		if _, err = tx.Exec(ctx, `INSERT INTO users(id) VALUES($1)`, userID); err != nil {
			return User{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO auth_identities(user_id,email) VALUES($1,$2)`, userID, email); err != nil {
			return User{}, err
		}
	} else if err != nil {
		return User{}, err
	}
	var deleted *time.Time
	if err = tx.QueryRow(ctx, `SELECT deleted_at FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&deleted); err != nil {
		return User{}, err
	}
	if deleted != nil {
		return User{}, commitError(ctx, tx, ErrUnauthenticated)
	}
	if _, err = tx.Exec(ctx, `UPDATE auth_challenges SET consumed_at=$2 WHERE id=$1`, a.ChallengeID, a.Now); err != nil {
		return User{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE auth_sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL`, a.PreviousSessionHash, a.Now); err != nil {
		return User{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)`, a.SessionHash, userID, a.Now, a.SessionExpiresAt); err != nil {
		return User{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return User{}, err
	}
	return User{ID: userID, Email: email}, nil
}
func (p *Postgres) Session(ctx context.Context, hash []byte, now time.Time) (User, error) {
	var user User
	err := p.pool.QueryRow(ctx, `SELECT u.id::text,i.email FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN auth_identities i ON i.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>$2 AND s.revoked_at IS NULL AND u.deleted_at IS NULL`, hash, now).Scan(&user.ID, &user.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUnauthenticated
	}
	return user, err
}
func (p *Postgres) Revoke(ctx context.Context, userID string, hash []byte, all bool, now time.Time) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialize account-wide revocation with session creation for the same user.
	if all {
		if _, err = tx.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE auth_sessions SET revoked_at=$4 WHERE user_id=$1 AND ($3 OR token_hash=$2) AND revoked_at IS NULL`, userID, hash, all, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (p *Postgres) Cleanup(ctx context.Context) error {
	for _, query := range []string{
		`DELETE FROM auth_challenges WHERE id IN (SELECT id FROM auth_challenges WHERE expires_at<now()-interval '1 hour' LIMIT 500)`,
		`DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at<now() OR revoked_at<now()-interval '1 day' LIMIT 500)`,
		`DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE window_start<now()-interval '1 day' LIMIT 500)`,
		`DELETE FROM auth_email_state WHERE email_key IN (SELECT email_key FROM auth_email_state WHERE last_requested_at<now()-interval '1 day' LIMIT 500)`,
	} {
		if _, err := p.pool.Exec(ctx, query); err != nil {
			return err
		}
	}
	return nil
}
