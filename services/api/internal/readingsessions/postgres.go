// Package readingsessions stores cumulative client reports. These records are
// not evidence of reading, verified calendar days, coverage or reward grants.
package readingsessions

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid         = errors.New("invalid reading session")
	ErrNotFound        = errors.New("reading session not found")
	ErrSessionReused   = errors.New("session identity changed")
	ErrOperationReused = errors.New("operation reused with different payload")
	uuid               = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

const MaxMilliseconds int64 = 86_400_000

type Report struct {
	SessionID    string `json:"sessionId"`
	DeviceID     string `json:"deviceId"`
	BookID       string `json:"bookId"`
	Version      string `json:"version"`
	Day          string `json:"day"`
	Milliseconds int64  `json:"milliseconds"`
}
type Change struct {
	OperationID string `json:"operationId"`
	Session     Report `json:"session"`
}
type Session struct {
	Report
	Revision int64 `json:"revision"`
}
type Page struct {
	Items      []Session `json:"items"`
	NextCursor string    `json:"nextCursor"`
}

// Cursor uses immutable ordering fields. Concurrent duration updates cannot move rows.
func ParseCursor(cursor string) (day, id string, ok bool) {
	if cursor == "" {
		return "", "", true
	}
	day, id, found := strings.Cut(cursor, "_")
	date, err := time.Parse("2006-01-02", day)
	return day, id, found && err == nil && date.Year() >= 1 && date.Format("2006-01-02") == day && ValidID(id)
}

type Store interface {
	List(context.Context, string, string, int) (Page, error)
	Get(context.Context, string, string) (Session, error)
	Apply(context.Context, string, Change) (Session, error)
}
type Postgres struct{ Pool *pgxpool.Pool }

func ValidID(id string) bool { return uuid.MatchString(id) }
func Valid(change Change) bool {
	p := change.Session
	day, err := time.Parse("2006-01-02", p.Day)
	return ValidID(change.OperationID) && ValidID(p.SessionID) && ValidID(p.DeviceID) && p.BookID != "" && p.Version != "" && err == nil && day.Year() >= 1 && day.Format("2006-01-02") == p.Day && p.Milliseconds >= 1 && p.Milliseconds <= MaxMilliseconds
}
func sameIdentity(a, b Report) bool {
	return a.SessionID == b.SessionID && a.DeviceID == b.DeviceID && a.BookID == b.BookID && a.Version == b.Version && a.Day == b.Day
}

const sessionColumns = `session_id::text,device_id::text,book_id,book_version,to_char(reported_day,'YYYY-MM-DD'),milliseconds,server_revision`

func scan(row pgx.Row) (Session, error) {
	var p Session
	err := row.Scan(&p.SessionID, &p.DeviceID, &p.BookID, &p.Version, &p.Day, &p.Milliseconds, &p.Revision)
	return p, err
}
func (s Postgres) Get(ctx context.Context, owner, id string) (Session, error) {
	p, err := scan(s.Pool.QueryRow(ctx, `SELECT `+sessionColumns+` FROM reading_sessions WHERE user_id=$1 AND session_id=$2`, owner, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	return p, err
}

// List is a live page, not an atomic snapshot of the entire history. New rows
// ahead of the cursor are visible on refresh; no aggregate credit is inferred.
func (s Postgres) List(ctx context.Context, owner, cursor string, limit int) (Page, error) {
	day, id, ok := ParseCursor(cursor)
	if !ok || limit < 1 || limit > 50 {
		return Page{}, ErrInvalid
	}
	query := `SELECT ` + sessionColumns + ` FROM reading_sessions WHERE user_id=$1`
	args := []any{owner, limit + 1}
	if cursor != "" {
		query += ` AND (reported_day,session_id) < ($3::text::date,$4::uuid)`
		args = append(args, day, id)
	}
	rows, err := s.Pool.Query(ctx, query+` ORDER BY reported_day DESC,session_id DESC LIMIT $2`, args...)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	result := Page{Items: make([]Session, 0, limit)}
	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return Page{}, err
		}
		result.Items = append(result.Items, item)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		last := result.Items[limit-1]
		result.NextCursor = last.Day + "_" + last.SessionID
	}
	return result, nil
}

type receipt struct {
	Kind        string  `json:"kind"`
	Fingerprint []byte  `json:"fingerprint"`
	Session     Session `json:"session"`
}

func (s Postgres) Apply(ctx context.Context, owner string, change Change) (Session, error) {
	if !Valid(change) {
		return Session{}, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback(ctx)
	// Share the owner lock and receipt namespace with position/bookmark writes.
	var id string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, owner).Scan(&id); err != nil {
		return Session{}, err
	}
	encoded, err := json.Marshal(change)
	if err != nil {
		return Session{}, err
	}
	fingerprint := sha256.Sum256(encoded)
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT result FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, owner, change.OperationID).Scan(&raw)
	if err == nil {
		var stored receipt
		if err = json.Unmarshal(raw, &stored); err != nil {
			return Session{}, err
		}
		if stored.Kind != "reading-session.apply.v1" || string(stored.Fingerprint) != string(fingerprint[:]) {
			return Session{}, ErrOperationReused
		}
		// This is the original acknowledgement, not a fresh session snapshot.
		return stored.Session, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Session{}, err
	}
	previous, err := scan(tx.QueryRow(ctx, `SELECT `+sessionColumns+` FROM reading_sessions WHERE user_id=$1 AND session_id=$2`, owner, change.Session.SessionID))
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Session{}, err
	}
	if exists && !sameIdentity(previous.Report, change.Session) {
		return Session{}, ErrSessionReused
	}
	result := previous
	if !exists || change.Session.Milliseconds > previous.Milliseconds {
		result = Session{Report: change.Session, Revision: previous.Revision + 1}
		p := result.Report
		_, err = tx.Exec(ctx, `INSERT INTO reading_sessions(user_id,session_id,device_id,book_id,book_version,reported_day,milliseconds,server_revision)
 VALUES($1,$2,$3,$4,$5,$6::text::date,$7,$8)
 ON CONFLICT(user_id,session_id) DO UPDATE SET milliseconds=excluded.milliseconds,server_revision=excluded.server_revision,updated_at=now()`, owner, p.SessionID, p.DeviceID, p.BookID, p.Version, p.Day, p.Milliseconds, result.Revision)
		if err != nil {
			return Session{}, err
		}
	}
	// A delayed smaller snapshot is acknowledged but never added or subtracted.
	stored, err := json.Marshal(receipt{Kind: "reading-session.apply.v1", Fingerprint: fingerprint[:], Session: result})
	if err != nil {
		return Session{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO processed_operations(user_id,operation_id,result) VALUES($1,$2,$3)`, owner, change.OperationID, stored); err != nil {
		return Session{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return result, nil
}
