// Package dailygoals stores historical targets and summarizes accepted client
// reports. A confirmed total acknowledges storage, not proof of reading or XP.
package dailygoals

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"
	_ "time/tzdata"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"lumyboo/services/api/internal/readingsessions"
)

var ErrInvalid = errors.New("invalid daily goal")
var ErrConflict = errors.New("daily goal changed")
var ErrNotFound = errors.New("daily goal not configured")

type Target struct {
	From    string `json:"from"`
	Minutes int    `json:"minutes"`
}
type Goal struct {
	TimeZone string   `json:"timeZone"`
	Revision int64    `json:"revision"`
	Changes  []Target `json:"changes"`
}
type Day struct {
	Day          string `json:"day"`
	Minutes      int    `json:"minutes"`
	Milliseconds int64  `json:"milliseconds"`
	Complete     bool   `json:"complete"`
}
type Snapshot struct {
	Goal     Goal `json:"goal"`
	Progress Day  `json:"progress"`
}
type Change struct {
	InitialChanges   []Target `json:"initialChanges,omitempty"`
	OperationID      string   `json:"operationId"`
	TimeZone         string   `json:"timeZone"`
	ExpectedRevision int64    `json:"expectedRevision"`
	From             string   `json:"from"`
	Minutes          int      `json:"minutes"`
}
type Store interface {
	Get(context.Context, string, string) (Snapshot, error)
	Apply(context.Context, string, Change) (Goal, error)
}
type Postgres struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

func (s Postgres) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func ValidDay(day string) bool {
	d, e := time.Parse("2006-01-02", day)
	return e == nil && d.Year() > 0 && d.Format("2006-01-02") == day
}
func Minutes(g Goal, day string) int {
	n := 20
	for _, t := range g.Changes {
		if t.From <= day {
			n = t.Minutes
		}
	}
	return n
}
func Valid(c Change) bool {
	_, e := time.LoadLocation(c.TimeZone)
	return readingsessions.ValidID(c.OperationID) && c.ExpectedRevision >= 0 && len(c.TimeZone) <= 100 && c.TimeZone != "" && c.TimeZone != "Local" && e == nil && ValidDay(c.From) && (c.Minutes == 5 || c.Minutes == 10 || c.Minutes == 20 || c.Minutes == 30 || c.Minutes == 60)
}
func load(ctx context.Context, tx pgx.Tx, owner string) (Goal, error) {
	g := Goal{Changes: []Target{}}
	err := tx.QueryRow(ctx, `SELECT time_zone,revision FROM daily_goal_settings WHERE user_id=$1`, owner).Scan(&g.TimeZone, &g.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return g, ErrNotFound
	}
	if err != nil {
		return g, err
	}
	rows, err := tx.Query(ctx, `SELECT to_char(effective_from,'YYYY-MM-DD'),minutes FROM daily_goal_changes WHERE user_id=$1 ORDER BY effective_from`, owner)
	if err != nil {
		return g, err
	}
	defer rows.Close()
	for rows.Next() {
		var t Target
		if err := rows.Scan(&t.From, &t.Minutes); err != nil {
			return g, err
		}
		g.Changes = append(g.Changes, t)
	}
	return g, rows.Err()
}
func (s Postgres) Get(ctx context.Context, owner, day string) (Snapshot, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Snapshot{}, err
	}
	defer tx.Rollback(ctx)
	g, err := load(ctx, tx, owner)
	if err != nil {
		return Snapshot{}, err
	}
	if day == "" {
		zone, _ := time.LoadLocation(g.TimeZone)
		day = s.now().In(zone).Format("2006-01-02")
	}
	if !ValidDay(day) {
		return Snapshot{}, ErrInvalid
	}
	p := Day{Day: day, Minutes: Minutes(g, day)}
	err = tx.QueryRow(ctx, `SELECT COALESCE(sum(milliseconds),0)::bigint FROM reading_sessions WHERE user_id=$1 AND reported_day=$2::text::date`, owner, day).Scan(&p.Milliseconds)
	p.Complete = p.Milliseconds >= int64(p.Minutes)*60000
	return Snapshot{Goal: g, Progress: p}, err
}
func (s Postgres) Apply(ctx context.Context, owner string, c Change) (Goal, error) {
	if !Valid(c) {
		return Goal{}, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Goal{}, err
	}
	defer tx.Rollback(ctx)
	var id string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, owner).Scan(&id); err != nil {
		return Goal{}, err
	}
	raw, _ := json.Marshal(c)
	fingerprint := sha256.Sum256(raw)
	var receipt []byte
	err = tx.QueryRow(ctx, `SELECT result FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, owner, c.OperationID).Scan(&receipt)
	if err == nil {
		var saved struct {
			Kind        string
			Fingerprint []byte
		}
		if json.Unmarshal(receipt, &saved) != nil || saved.Kind != "daily-goal.v1" || string(saved.Fingerprint) != string(fingerprint[:]) {
			return Goal{}, ErrConflict
		}
		// A retry acknowledges the original mutation but returns current settings.
		return load(ctx, tx, owner)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Goal{}, err
	}
	g, err := load(ctx, tx, owner)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Goal{}, err
	}
	if g.Revision != c.ExpectedRevision {
		return Goal{}, ErrConflict
	}
	if g.Revision == 0 {
		g.TimeZone = c.TimeZone
	} else if g.TimeZone != c.TimeZone {
		return Goal{}, ErrConflict
	}
	zone, _ := time.LoadLocation(g.TimeZone)
	today := s.now().In(zone)
	if c.From != today.AddDate(0, 0, 1).Format("2006-01-02") {
		return Goal{}, ErrInvalid
	}
	if g.Revision == 0 {
		last := ""
		if len(c.InitialChanges) > 3660 {
			return Goal{}, ErrInvalid
		}
		for _, target := range c.InitialChanges {
			check := c
			check.From = target.From
			check.Minutes = target.Minutes
			if !Valid(check) || target.From <= last || target.From > c.From {
				return Goal{}, ErrInvalid
			}
			last = target.From
		}
		if _, err = tx.Exec(ctx, `INSERT INTO daily_goal_settings(user_id,time_zone,revision) VALUES($1,$2,1)`, owner, g.TimeZone); err != nil {
			return Goal{}, err
		}
		if len(c.InitialChanges) == 0 || c.InitialChanges[0].From > today.Format("2006-01-02") {
			if _, err = tx.Exec(ctx, `INSERT INTO daily_goal_changes(user_id,effective_from,minutes) VALUES($1,$2::text::date,20)`, owner, today.Format("2006-01-02")); err != nil {
				return Goal{}, err
			}
		}
		for _, target := range c.InitialChanges {
			if _, err = tx.Exec(ctx, `INSERT INTO daily_goal_changes(user_id,effective_from,minutes) VALUES($1,$2::text::date,$3) ON CONFLICT(user_id,effective_from) DO UPDATE SET minutes=excluded.minutes`, owner, target.From, target.Minutes); err != nil {
				return Goal{}, err
			}
		}
	} else {
		if len(c.InitialChanges) > 0 {
			return Goal{}, ErrInvalid
		}
		if _, err = tx.Exec(ctx, `UPDATE daily_goal_settings SET revision=revision+1 WHERE user_id=$1`, owner); err != nil {
			return Goal{}, err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO daily_goal_changes(user_id,effective_from,minutes) VALUES($1,$2::text::date,$3) ON CONFLICT(user_id,effective_from) DO UPDATE SET minutes=excluded.minutes`, owner, c.From, c.Minutes); err != nil {
		return Goal{}, err
	}
	receipt, _ = json.Marshal(struct {
		Kind        string
		Fingerprint []byte
	}{"daily-goal.v1", fingerprint[:]})
	if _, err = tx.Exec(ctx, `INSERT INTO processed_operations(user_id,operation_id,result) VALUES($1,$2,$3)`, owner, c.OperationID, receipt); err != nil {
		return Goal{}, err
	}
	g, err = load(ctx, tx, owner)
	if err != nil {
		return Goal{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Goal{}, err
	}
	return g, nil
}
