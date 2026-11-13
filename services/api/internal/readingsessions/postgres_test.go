package readingsessions

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgconn"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"lumyboo/services/api/internal/bookmarks"
	"lumyboo/services/api/internal/positions"
)

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func sample() Change {
	return Change{OperationID: newID(), Session: Report{SessionID: newID(), DeviceID: newID(), BookID: "room-for-stories", Version: "1", Day: "2026-11-13", Milliseconds: 1234}}
}
func TestValidation(t *testing.T) {
	valid := sample()
	for _, day := range []string{"0001-01-01", "2024-02-29", "9999-12-31"} {
		p := valid
		p.Session.Day = day
		if !Valid(p) {
			t.Fatal("valid day rejected", day)
		}
	}
	cases := []Change{}
	for _, day := range []string{"0000-01-01", "2026-02-29", "2026-11-31", "2026-1-01", "2026-11-13T00:00:00Z", ""} {
		p := valid
		p.Session.Day = day
		cases = append(cases, p)
	}
	for _, ms := range []int64{-1, 0, MaxMilliseconds + 1} {
		p := valid
		p.Session.Milliseconds = ms
		cases = append(cases, p)
	}
	p := valid
	p.OperationID = "bad"
	cases = append(cases, p)
	p = valid
	p.Session.SessionID = ""
	cases = append(cases, p)
	p = valid
	p.Session.DeviceID = ""
	cases = append(cases, p)
	p = valid
	p.Session.BookID = ""
	cases = append(cases, p)
	p = valid
	p.Session.Version = ""
	cases = append(cases, p)
	for _, p := range cases {
		if Valid(p) {
			t.Fatal("invalid report accepted", p)
		}
	}
	p = valid
	p.Session.Milliseconds = MaxMilliseconds
	if !Valid(p) {
		t.Fatal("maximum rejected")
	}
}
func TestPostgresReadingSessions(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL integration")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	user := func() string {
		t.Helper()
		id := newID()
		if _, err := pool.Exec(ctx, `INSERT INTO users(id) VALUES($1)`, id); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id) })
		return id
	}
	a, b := user(), user()
	store := Postgres{Pool: pool}
	first := sample()
	saved, err := store.Apply(ctx, a, first)
	if err != nil || saved.Milliseconds != 1234 || saved.Revision != 1 {
		t.Fatal(saved, err)
	}
	if replay, err := store.Apply(ctx, a, first); err != nil || replay != saved {
		t.Fatal("replay", replay, err)
	}
	if _, err := store.Get(ctx, b, first.Session.SessionID); !errors.Is(err, ErrNotFound) {
		t.Fatal("another owner sees session", err)
	}
	if other, err := store.Apply(ctx, b, first); err != nil || other != saved {
		t.Fatal("ID not owner scoped", other, err)
	}
	next := first
	next.OperationID = newID()
	next.Session.Milliseconds = 3400
	updated, err := store.Apply(ctx, a, next)
	if err != nil || updated.Milliseconds != 3400 || updated.Revision != 2 {
		t.Fatal(updated, err)
	}
	late := first
	late.OperationID = newID()
	if result, err := store.Apply(ctx, a, late); err != nil || result != updated {
		t.Fatal("late report reduced/added time", result, err)
	}
	equal := next
	equal.OperationID = newID()
	if result, err := store.Apply(ctx, a, equal); err != nil || result != updated {
		t.Fatal("equal report changed revision", result, err)
	}
	if replay, err := store.Apply(ctx, a, first); err != nil || replay != saved {
		t.Fatal("late retry did not return original receipt", replay, err)
	}
	changed := first
	changed.Session.Milliseconds++
	if _, err := store.Apply(ctx, a, changed); !errors.Is(err, ErrOperationReused) {
		t.Fatal("operation reuse", err)
	}
	for _, field := range []string{"device", "book", "version", "day"} {
		change := next
		change.OperationID = newID()
		switch field {
		case "device":
			change.Session.DeviceID = newID()
		case "book":
			change.Session.BookID = "other"
		case "version":
			change.Session.Version = "2"
		case "day":
			change.Session.Day = "2026-11-14"
		}
		if _, err := store.Apply(ctx, a, change); !errors.Is(err, ErrSessionReused) {
			t.Fatal("identity changed", field, err)
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, a, change.OperationID).Scan(&count); err != nil || count != 0 {
			t.Fatal("conflict receipt persisted", err, count)
		}
	}
	// Concurrent cumulative snapshots converge to the largest, never their sum.
	concurrent := sample()
	var wg sync.WaitGroup
	failures := make(chan error, 8)
	for i := 1; i <= 8; i++ {
		change := concurrent
		change.OperationID = newID()
		change.Session.Milliseconds = int64(i * 1000)
		wg.Go(func() { _, err := store.Apply(ctx, a, change); failures <- err })
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	result, err := store.Get(ctx, a, concurrent.Session.SessionID)
	if err != nil || result.Milliseconds != 8000 {
		t.Fatal("parallel snapshots", result, err)
	}
	// Concurrent exact retries produce one row, receipt and revision.
	duplicate := sample()
	failures = make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Go(func() { _, err := store.Apply(ctx, a, duplicate); failures <- err })
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	result, err = store.Get(ctx, a, duplicate.Session.SessionID)
	if err != nil || result.Revision != 1 {
		t.Fatal("duplicate", result, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, a, duplicate.OperationID).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate receipt", err, count)
	}
	// Other devices use different sessions and are never merged by book/day.
	separate := first
	separate.OperationID = newID()
	separate.Session.SessionID = newID()
	separate.Session.DeviceID = newID()
	if _, err := store.Apply(ctx, a, separate); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reading_sessions WHERE user_id=$1 AND session_id IN ($2,$3)`, a, first.Session.SessionID, separate.Session.SessionID).Scan(&count); err != nil || count != 2 {
		t.Fatal("devices merged", err, count)
	}
	// Failed FK and receipt writes must roll back the complete operation.
	invalid := sample()
	invalid.Session.Version = "missing"
	if _, err := store.Apply(ctx, a, invalid); err == nil {
		t.Fatal("invalid edition accepted")
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, a, invalid.OperationID).Scan(&count); err != nil || count != 0 {
		t.Fatal("partial receipt", err, count)
	}
	if _, err := store.Get(ctx, a, invalid.Session.SessionID); !errors.Is(err, ErrNotFound) {
		t.Fatal("partial session", err)
	}
	// A kind collision cannot mutate sessions, and the reverse cannot change positions/bookmarks.
	collision := sample()
	raw, _ := json.Marshal(map[string]string{"kind": "position.choose.v1"})
	if _, err := pool.Exec(ctx, `INSERT INTO processed_operations(user_id,operation_id,result) VALUES($1,$2,$3)`, a, collision.OperationID, raw); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, a, collision); !errors.Is(err, ErrOperationReused) {
		t.Fatal("cross-kind", err)
	}
	if _, err := (positions.Postgres{Pool: pool}).Choose(ctx, a, positions.Choice{OperationID: first.OperationID, Position: positions.Locator{BookID: "room-for-stories", Version: "1", Paragraph: "ch-1-p-1"}}); !errors.Is(err, positions.ErrOperationReused) {
		t.Fatal("position reused session operation", err)
	}
	if _, err := (bookmarks.Postgres{Pool: pool}).Apply(ctx, a, bookmarks.Change{OperationID: first.OperationID, Bookmark: bookmarks.Entry{BookID: "room-for-stories", Version: "1", Paragraph: "ch-1-p-1"}}); !errors.Is(err, bookmarks.ErrOperationReused) {
		t.Fatal("bookmark reused session operation", err)
	}
	// Force receipt insertion to fail after an existing session update. The
	// transaction must restore its previous total/revision and allow a retry.
	role := `reading_sessions_fail_` + fmt.Sprintf("%x", []byte(newID())[:4])
	if _, err := pool.Exec(ctx, `CREATE ROLE `+role); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(ctx, `DROP OWNED BY `+role); pool.Exec(ctx, `DROP ROLE `+role) })
	if _, err := pool.Exec(ctx, `GRANT USAGE ON SCHEMA public TO `+role+`; GRANT SELECT, UPDATE ON users TO `+role+`; GRANT SELECT,INSERT,UPDATE ON reading_sessions TO `+role+`; GRANT SELECT ON processed_operations TO `+role); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["role"] = role
	restricted, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restricted.Close()
	failing := next
	failing.OperationID = newID()
	failing.Session.Milliseconds = 5000
	if _, err := (Postgres{Pool: restricted}).Apply(ctx, a, failing); err == nil {
		t.Fatal("receipt failure expected")
	} else {
		var denied *pgconn.PgError
		if !errors.As(err, &denied) || denied.Code != "42501" || !strings.Contains(denied.Message, "processed_operations") {
			t.Fatal("failed before receipt insertion", err)
		}
	}
	if actual, err := store.Get(ctx, a, first.Session.SessionID); err != nil || actual != updated {
		t.Fatal("partial update", actual, err)
	}
	if _, err := store.Apply(ctx, a, failing); err != nil {
		t.Fatal("retry after rollback", err)
	}
	// Soft-deleted owners cannot submit reports.
	deleted := user()
	if _, err := pool.Exec(ctx, `UPDATE users SET deleted_at=now() WHERE id=$1`, deleted); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, deleted, sample()); err == nil {
		t.Fatal("deleted owner accepted")
	}
}
