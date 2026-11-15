package challenges

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"lumyboo/services/api/internal/readingsessions"
)

type Action struct {
	Kind        string `json:"kind"`
	ChallengeID string `json:"challengeId"`
	Code        string `json:"code"`
	Nickname    string `json:"nickname"`
	Minutes     int    `json:"minutes"`
}
type ActionResult struct {
	Challenge Challenge `json:"challenge"`
	Code      string    `json:"code,omitempty"`
}

func ValidAction(a Action) bool {
	switch a.Kind {
	case "invite", "revoke", "leave":
		return readingsessions.ValidID(a.ChallengeID)
	case "preview", "join":
		raw, err := hex.DecodeString(a.Code)
		return err == nil && len(raw) == 24 && (a.Kind == "preview" || clean(a.Nickname, 40) && validMinutes(a.Minutes))
	}
	return false
}
func validMinutes(n int) bool { return n == 5 || n == 10 || n == 20 || n == 30 || n == 60 }

// All membership and invitation changes lock the challenge first. This makes
// capacity, revocation and simultaneous joins one ordered decision in PostgreSQL.
func (s Postgres) Action(ctx context.Context, user string, a Action) (ActionResult, error) {
	var out ActionResult
	if !ValidAction(a) {
		return out, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	var owner string
	var commonMinutes int
	var revoked bool
	c := Challenge{Members: []Member{}}
	selector := `c.id=$1`
	value := a.ChallengeID
	if a.Kind == "preview" || a.Kind == "join" {
		selector = `c.id=(SELECT challenge_id FROM challenge_invitations WHERE code=$1)`
		value = a.Code
	}
	err = tx.QueryRow(ctx, `SELECT c.id::text,c.owner_id::text,c.name,c.mode,to_char(c.start_day,'YYYY-MM-DD'),c.duration,c.time_zone,c.minutes FROM challenges c WHERE `+selector+` FOR UPDATE`, value).Scan(&c.ID, &owner, &c.Name, &c.Mode, &c.StartDay, &c.Duration, &c.TimeZone, &commonMinutes)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrUnavailable
	}
	if err != nil {
		return out, err
	}
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	zone, _ := time.LoadLocation(c.TimeZone)
	beforeStart := now.In(zone).Format("2006-01-02") < c.StartDay
	var left bool
	memberErr := tx.QueryRow(ctx, `SELECT left_at IS NOT NULL FROM challenge_members WHERE challenge_id=$1 AND user_id=$2`, c.ID, user).Scan(&left)
	if memberErr != nil && !errors.Is(memberErr, pgx.ErrNoRows) {
		return out, memberErr
	}
	member := memberErr == nil
	if a.Kind == "preview" || a.Kind == "join" {
		if err = tx.QueryRow(ctx, `SELECT revoked FROM challenge_invitations WHERE code=$1`, a.Code).Scan(&revoked); err != nil {
			return out, err
		}
		// Existing membership retries succeed even after start or revocation; a left
		// membership is terminal, so a late retry cannot silently rejoin the reader.
		if !member && (revoked || !beforeStart) {
			return out, ErrUnavailable
		}
		if a.Kind == "join" && !member {
			var count int
			if err = tx.QueryRow(ctx, `SELECT count(*) FROM challenge_members WHERE challenge_id=$1 AND left_at IS NULL`, c.ID).Scan(&count); err != nil {
				return out, err
			}
			if count >= 10 {
				return out, ErrFull
			}
			minutes := a.Minutes
			if c.Mode == "competitive" {
				minutes = commonMinutes
			}
			if _, err = tx.Exec(ctx, `INSERT INTO challenge_members(challenge_id,user_id,nickname,minutes) VALUES($1,$2,$3,$4)`, c.ID, user, a.Nickname, minutes); err != nil {
				return out, err
			}
			member = true
		}
	} else {
		if !member {
			return out, ErrUnavailable
		}
		switch a.Kind {
		case "invite", "revoke":
			if owner != user || left {
				return out, ErrUnavailable
			}
			if a.Kind == "revoke" {
				_, err = tx.Exec(ctx, `UPDATE challenge_invitations SET revoked=true WHERE challenge_id=$1 AND NOT revoked`, c.ID)
			} else {
				if !beforeStart {
					return out, ErrUnavailable
				}
				err = tx.QueryRow(ctx, `SELECT code FROM challenge_invitations WHERE challenge_id=$1 AND NOT revoked`, c.ID).Scan(&out.Code)
				if errors.Is(err, pgx.ErrNoRows) {
					var bytes [24]byte
					if _, err = rand.Read(bytes[:]); err != nil {
						return out, err
					}
					out.Code = hex.EncodeToString(bytes[:])
					_, err = tx.Exec(ctx, `INSERT INTO challenge_invitations(code,challenge_id) VALUES($1,$2)`, out.Code, c.ID)
				}
			}
		case "leave":
			_, err = tx.Exec(ctx, `UPDATE challenge_members SET left_at=COALESCE(left_at,now()) WHERE challenge_id=$1 AND user_id=$2`, c.ID, user)
			if err == nil && owner == user {
				_, err = tx.Exec(ctx, `UPDATE challenge_invitations SET revoked=true WHERE challenge_id=$1 AND NOT revoked`, c.ID)
			}
		}
		if err != nil {
			return out, err
		}
	}
	if member {
		c, err = scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM challenges c JOIN challenge_members m ON m.challenge_id=c.id AND m.user_id=$1 WHERE c.id=$2`, user, c.ID))
		if err != nil {
			return out, err
		}
	} else {
		// Possession of an active code reveals conditions, never the member roster.
		c.Minutes = commonMinutes
	}
	out.Challenge = c
	if err = tx.Commit(ctx); err != nil {
		return ActionResult{}, err
	}
	return out, nil
}
