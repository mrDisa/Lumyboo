package bookmarks

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEntryIdentityIncludesOwnerAndEdition(t *testing.T) {
	entry := Entry{BookID: "book", Version: "1", Paragraph: "p1", Offset: .2}
	id := entryID("a", entry)
	entry.Offset = .6
	entry.Label = "new label"
	if id != entryID("a", entry) || id == entryID("b", entry) {
		t.Fatal("unstable or shared bookmark identity")
	}
	entry.Version = "2"
	if id == entryID("a", entry) {
		t.Fatal("editions collided")
	}
}
func TestPostgresBookmarkImport(t *testing.T) {
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
		var b [16]byte
		if _, err := rand.Read(b[:]); err != nil {
			t.Fatal(err)
		}
		id := fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
		if _, err := pool.Exec(ctx, `INSERT INTO users(id) VALUES($1)`, id); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id) })
		return id
	}
	a, b := user(), user()
	store := Postgres{Pool: pool}
	entry := Entry{BookID: "room-for-stories", Version: "1", Chapter: 0, Paragraph: "p1", Offset: .2, Label: "original"}
	if _, err := store.Import(ctx, a, []Entry{entry}); err != nil {
		t.Fatal(err)
	}
	replacement := entry
	replacement.Label = "guest replacement"
	replacement.Offset = .8
	var wg sync.WaitGroup
	results := make(chan error, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := store.Import(ctx, a, []Entry{replacement}); results <- err }()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	entries, err := store.List(ctx, a)
	if err != nil || len(entries) != 1 || entries[0] != entry {
		t.Fatal("existing bookmark overwritten or duplicated", entries, err)
	}
	if _, err := store.Import(ctx, b, []Entry{replacement}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE bookmarks SET deleted_at=now() WHERE user_id=$1`, a); err != nil {
		t.Fatal(err)
	}
	entries, err = store.Import(ctx, a, []Entry{replacement})
	if err != nil || len(entries) != 0 {
		t.Fatal("tombstone resurrected", entries, err)
	}
	entries, err = store.List(ctx, b)
	if err != nil || len(entries) != 1 || entries[0] != replacement {
		t.Fatal("other owner changed", entries, err)
	}
	fresh := entry
	fresh.Paragraph = "p2"
	invalid := entry
	invalid.Version = "missing-edition"
	if _, err := store.Import(ctx, a, []Entry{fresh, invalid}); err == nil {
		t.Fatal("missing edition accepted")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM bookmarks WHERE user_id=$1`, a).Scan(&count); err != nil || count != 1 {
		t.Fatal("failed batch partially committed", count, err)
	}
}
