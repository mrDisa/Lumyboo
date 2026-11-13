package bookmarks

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

func TestPostgresBookmarkChanges(t *testing.T) {
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
	uuid := func() string {
		t.Helper()
		var b [16]byte
		if _, err := rand.Read(b[:]); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
	}
	user := func() string {
		t.Helper()
		id := uuid()
		if _, err := pool.Exec(ctx, `INSERT INTO users(id) VALUES($1)`, id); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id) })
		return id
	}
	a, b := user(), user()
	store := Postgres{Pool: pool}
	entry := Entry{BookID: "room-for-stories", Version: "1", Chapter: 0, Paragraph: "ch-1-p-1", Offset: .2, Label: "original"}
	first := Change{OperationID: uuid(), Bookmark: entry}
	saved, err := store.Apply(ctx, a, first)
	if err != nil || saved != (State{Entry: entry, Revision: 1}) {
		t.Fatal(saved, err)
	}
	if replay, err := store.Apply(ctx, a, first); err != nil || replay != saved {
		t.Fatal("retry changed result", replay, err)
	}
	for _, mutate := range []func(*Change){
		func(c *Change) { c.Bookmark.Offset = .8 },
		func(c *Change) { c.Bookmark.Label = "changed" },
		func(c *Change) { c.ExpectedRevision = 1 },
		func(c *Change) { c.Deleted = true },
	} {
		reused := first
		mutate(&reused)
		if _, err := store.Apply(ctx, a, reused); !errors.Is(err, ErrOperationReused) {
			t.Fatal("reused ID accepted", err)
		}
	}
	if other, err := store.Apply(ctx, b, first); err != nil || other != saved {
		t.Fatal("operation not scoped to owner", other, err)
	}
	// Two writes based on the same snapshot cannot both succeed.
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		change := Change{OperationID: uuid(), ExpectedRevision: 1, Bookmark: entry, Deleted: true}
		wg.Add(1)
		go func() { defer wg.Done(); _, err := store.Apply(ctx, a, change); results <- err }()
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal("concurrent writes", successes, conflicts)
	}
	states, err := store.State(ctx, a)
	if err != nil || len(states) != 1 || states[0].Revision != 2 || !states[0].Deleted {
		t.Fatal(states, err)
	}
	if active, err := store.List(ctx, a); err != nil || len(active) != 0 {
		t.Fatal("deleted entry still active", active, err)
	}
	if _, err := store.Import(ctx, a, []Entry{entry}); err != nil {
		t.Fatal(err)
	}
	stale := Change{OperationID: uuid(), ExpectedRevision: 1, Bookmark: entry}
	if _, err := store.Apply(ctx, a, stale); !errors.Is(err, ErrConflict) {
		t.Fatal("old device resurrected deletion", err)
	}
	if replay, err := store.Apply(ctx, a, first); err != nil || replay != saved {
		t.Fatal("late retry changed original receipt", replay, err)
	}
	if states, err := store.State(ctx, a); err != nil || len(states) != 1 || states[0].Revision != 2 || !states[0].Deleted {
		t.Fatal("import or retry resurrected deletion", states, err)
	}
	restore := Change{OperationID: uuid(), ExpectedRevision: 2, Bookmark: entry}
	restore.Bookmark.Label = "restored"
	if result, err := store.Apply(ctx, a, restore); err != nil || result.Revision != 3 || result.Deleted || result.Label != "restored" {
		t.Fatal(result, err)
	}
	if other, err := store.State(ctx, b); err != nil || len(other) != 1 || other[0] != saved {
		t.Fatal("other owner changed", other, err)
	}
	// Even an absent local deletion establishes a tombstone; imports cannot undo it.
	absent := entry
	absent.Paragraph = "ch-1-p-2"
	deletion := Change{OperationID: uuid(), Bookmark: absent, Deleted: true}
	if result, err := store.Apply(ctx, a, deletion); err != nil || !result.Deleted || result.Revision != 1 {
		t.Fatal(result, err)
	}
	if _, err := store.Import(ctx, a, []Entry{absent}); err != nil {
		t.Fatal(err)
	}
	// An imported bookmark starts at revision 1 and can be edited by natural key.
	imported := entry
	imported.Paragraph = "ch-1-p-3"
	if _, err := store.Import(ctx, a, []Entry{imported}); err != nil {
		t.Fatal(err)
	}
	// Simulate a legacy random UUID instead of the current derived one.
	if _, err := pool.Exec(ctx, `UPDATE bookmarks SET id=$1 WHERE user_id=$2 AND locator->>'paragraph'=$3`, uuid(), a, imported.Paragraph); err != nil {
		t.Fatal(err)
	}
	update := Change{OperationID: uuid(), ExpectedRevision: 1, Bookmark: imported}
	update.Bookmark.Offset = .9
	if result, err := store.Apply(ctx, a, update); err != nil || result.Revision != 2 || result.Offset != .9 {
		t.Fatal("legacy identity", result, err)
	}
	states, err = store.State(ctx, a)
	if err != nil || len(states) != 3 {
		t.Fatal("duplicate natural identity", states, err)
	}
	// Simultaneous retries of the same UUID must commit exactly once.
	retryEntry := entry
	retryEntry.Paragraph = "ch-1-p-4"
	retry := Change{OperationID: uuid(), Bookmark: retryEntry}
	replays := make(chan State, 2)
	retryErrors := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			state, err := store.Apply(ctx, a, retry)
			replays <- state
			retryErrors <- err
		}()
	}
	wg.Wait()
	for i := 0; i < 2; i++ {
		if err := <-retryErrors; err != nil {
			t.Fatal(err)
		}
		if state := <-replays; state.Revision != 1 || state.Entry != retryEntry {
			t.Fatal("concurrent replay", state)
		}
	}
	// Import and synchronization share a lock even for a missing natural key.
	racingEntry := entry
	racingEntry.Paragraph = "ch-1-p-5"
	racingDelete := Change{OperationID: uuid(), Bookmark: racingEntry, Deleted: true}
	raceErrors := make(chan error, 2)
	wg.Add(2)
	go func() { defer wg.Done(); _, err := store.Import(ctx, a, []Entry{racingEntry}); raceErrors <- err }()
	go func() { defer wg.Done(); _, err := store.Apply(ctx, a, racingDelete); raceErrors <- err }()
	wg.Wait()
	for i := 0; i < 2; i++ {
		if err := <-raceErrors; err != nil && !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	var identities int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM bookmarks WHERE user_id=$1 AND locator->>'paragraph'=$2`, a, racingEntry.Paragraph).Scan(&identities); err != nil || identities != 1 {
		t.Fatal("import/sync duplicated identity", identities, err)
	}
	// Unknown editions roll back both mutation and receipt.
	invalid := Change{OperationID: uuid(), Bookmark: entry}
	invalid.Bookmark.Version = "missing-edition"
	if _, err := store.Apply(ctx, a, invalid); err == nil {
		t.Fatal("unknown edition accepted")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, a, invalid.OperationID).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed write acknowledged", count, err)
	}
	// UUIDs are shared across operation kinds; a position receipt cannot be reused.
	collision := Change{OperationID: uuid(), Bookmark: entry, ExpectedRevision: 3}
	if _, err := pool.Exec(ctx, `INSERT INTO processed_operations(user_id,operation_id,result) VALUES($1,$2,'{"kind":"position.choose.v1"}')`, a, collision.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, a, collision); !errors.Is(err, ErrOperationReused) {
		t.Fatal("cross-kind collision", err)
	}
}
