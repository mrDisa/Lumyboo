// Package challenges stores private challenges and their fixed targets.
package challenges

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"lumyboo/services/api/internal/dailygoals"
	"lumyboo/services/api/internal/readingsessions"
)

var ErrInvalid = errors.New("invalid challenge")
var ErrConflict = errors.New("operation already used with different conditions")

type Create struct {
	OperationID string `json:"operationId"`
	Name        string `json:"name"`
	Mode        string `json:"mode"`
	StartDay    string `json:"startDay"`
	Duration    int    `json:"duration"`
	TimeZone    string `json:"timeZone"`
	Minutes     int    `json:"minutes"`
	Nickname    string `json:"nickname"`
}
type Challenge struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Mode     string `json:"mode"`
	StartDay string `json:"startDay"`
	Duration int    `json:"duration"`
	TimeZone string `json:"timeZone"`
	Minutes  int    `json:"minutes"`
	Nickname string `json:"nickname"`
}
type Store interface {
	List(context.Context, string) ([]Challenge, error)
	Create(context.Context, string, Create) (Challenge, error)
}
type Postgres struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

func clean(s string, max int) bool {
	return strings.TrimSpace(s) == s && len([]rune(s)) > 0 && len([]rune(s)) <= max && !strings.ContainsFunc(s, unicode.IsControl)
}
func Valid(c Create) bool {
	_, err := time.LoadLocation(c.TimeZone)
	return readingsessions.ValidID(c.OperationID) && clean(c.Name, 60) && clean(c.Nickname, 40) &&
		(c.Mode == "competitive" || c.Mode == "personal") && dailygoals.ValidDay(c.StartDay) &&
		(c.Duration == 7 || c.Duration == 14 || c.Duration == 30) &&
		(c.Minutes == 5 || c.Minutes == 10 || c.Minutes == 20 || c.Minutes == 30 || c.Minutes == 60) &&
		c.TimeZone != "" && c.TimeZone != "Local" && len(c.TimeZone) <= 100 && err == nil
}

const columns = `c.id::text,c.name,c.mode,to_char(c.start_day,'YYYY-MM-DD'),c.duration,c.time_zone,m.minutes,m.nickname`

func scan(row pgx.Row) (Challenge, error) {
	var c Challenge
	err := row.Scan(&c.ID, &c.Name, &c.Mode, &c.StartDay, &c.Duration, &c.TimeZone, &c.Minutes, &c.Nickname)
	return c, err
}
func (s Postgres) List(ctx context.Context, owner string) ([]Challenge, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+columns+` FROM challenges c JOIN challenge_members m ON m.challenge_id=c.id AND m.user_id=$1 WHERE c.owner_id=$1 ORDER BY c.created_at DESC,c.id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Challenge{}
	for rows.Next() {
		c, err := scan(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}
func (s Postgres) Create(ctx context.Context, owner string, input Create) (Challenge, error) {
	if !Valid(input) {
		return Challenge{}, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Challenge{}, err
	}
	defer tx.Rollback(ctx)
	// Serialize creation and retries for an owner, including concurrent devices.
	var id string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, owner).Scan(&id); err != nil {
		return Challenge{}, err
	}
	raw, _ := json.Marshal(input)
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	var savedHash string
	err = tx.QueryRow(ctx, `SELECT request_hash FROM challenges WHERE owner_id=$1 AND operation_id=$2`, owner, input.OperationID).Scan(&savedHash)
	if err == nil {
		if savedHash != hash {
			return Challenge{}, ErrConflict
		}
		return scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM challenges c JOIN challenge_members m ON m.challenge_id=c.id AND m.user_id=$1 WHERE c.owner_id=$1 AND c.operation_id=$2`, owner, input.OperationID))
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Challenge{}, err
	}
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	zone, _ := time.LoadLocation(input.TimeZone)
	if input.StartDay <= now.In(zone).Format("2006-01-02") {
		return Challenge{}, ErrInvalid
	}
	if err = tx.QueryRow(ctx, `INSERT INTO challenges(owner_id,operation_id,request_hash,name,mode,start_day,duration,time_zone,minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`, owner, input.OperationID, hash, input.Name, input.Mode, input.StartDay, input.Duration, input.TimeZone, input.Minutes).Scan(&id); err != nil {
		return Challenge{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO challenge_members(challenge_id,user_id,nickname,minutes) VALUES($1,$2,$3,$4)`, id, owner, input.Nickname, input.Minutes); err != nil {
		return Challenge{}, err
	}
	result, err := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM challenges c JOIN challenge_members m ON m.challenge_id=c.id AND m.user_id=$1 WHERE c.id=$2`, owner, id))
	if err != nil {
		return Challenge{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Challenge{}, err
	}
	return result, nil
}
