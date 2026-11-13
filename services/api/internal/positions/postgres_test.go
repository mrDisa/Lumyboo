package positions

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func uuid(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func TestPostgresPositionChoice(t *testing.T) {
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
		id := uuid(t)
		if _, err := pool.Exec(ctx, `INSERT INTO users(id) VALUES($1)`, id); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id) })
		return id
	}
	a, b := user(), user()
	store := Postgres{Pool: pool}
	local := Locator{BookID: "room-for-stories", Version: "1", Chapter: 1, Paragraph: "ch-2-p-1", Offset: .3}
	first := Choice{OperationID: uuid(t), ExpectedRevision: 0, Position: local}
	saved, err := store.Choose(ctx, a, first)
	if err != nil || saved.Revision != 1 {
		t.Fatal(saved, err)
	}
	if replay, err := store.Choose(ctx, a, first); err != nil || replay != saved {
		t.Fatal("replay changed result", replay, err)
	}
	reused := first
	reused.Position.Offset = .9
	if _, err := store.Choose(ctx, a, reused); !errors.Is(err, ErrOperationReused) {
		t.Fatal("operation reused", err)
	}
	other, err := store.Choose(ctx, b, first)
	if err != nil || other.Revision != 1 {
		t.Fatal("operation ID was not owner-scoped", other, err)
	}
	stale := first
	stale.OperationID = uuid(t)
	if _, err := store.Choose(ctx, a, stale); !errors.Is(err, ErrConflict) {
		t.Fatal("stale revision overwrote", err)
	}
	// A choice may move backwards. It must never pick the greatest chapter.
	next := Choice{OperationID: uuid(t), ExpectedRevision: 1, Position: local}
	next.Position.Chapter = 0
	next.Position.Paragraph = "ch-1-p-1"
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		choice := next
		choice.OperationID = uuid(t)
		wg.Add(1)
		go func() { defer wg.Done(); _, err := store.Choose(ctx, a, choice); results <- err }()
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("concurrent choices were not serialized", success, conflict)
	}
	entries, err := store.List(ctx, a)
	if err != nil || len(entries) != 1 || entries[0].Revision != 2 || entries[0].Chapter != 0 {
		t.Fatal(entries, err)
	}
	replay, err := store.Choose(ctx, a, first)
	if err != nil || replay != saved {
		t.Fatal("late replay did not acknowledge original operation", replay, err)
	}
	var old []byte
	var revision int64
	if err := pool.QueryRow(ctx, `SELECT locator,server_revision FROM reading_position_history WHERE user_id=$1 AND book_id=$2`, a, local.BookID).Scan(&old, &revision); err != nil || revision != 1 {
		t.Fatal("old variant missing", revision, err)
	}
	entries, err = store.List(ctx, b)
	if err != nil || len(entries) != 1 || entries[0].Revision != 1 || entries[0].Locator != local {
		t.Fatal("another owner changed", entries, err)
	}
	invalid := Choice{OperationID: uuid(t), ExpectedRevision: 2, Position: local}
	invalid.Position.Version = "missing-edition"
	if _, err := store.Choose(ctx, a, invalid); err == nil {
		t.Fatal("missing edition accepted")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reading_position_history WHERE user_id=$1`, a).Scan(&count); err != nil || count != 1 {
		t.Fatal("history partially committed", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, a, invalid.OperationID).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed choice acknowledged", count, err)
	}
}
