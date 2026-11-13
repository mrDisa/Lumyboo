package readingcoverage

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"lumyboo/services/api/internal/readingsessions"
)

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func sample() Change {
	return Change{OperationID: newID(), Coverage: Coverage{BookID: "room-for-stories", Version: "1", Paragraph: "ch-1-p-1", Ranges: []Range{{0, 200000}, {800000, Scale}}}}
}
func TestRanges(t *testing.T) {
	input := []Range{{800000, Scale}, {0, 100000}, {100000, 200000}, {50000, 150000}}
	before := append([]Range(nil), input...)
	merged, err := Merge(input)
	if err != nil || !reflect.DeepEqual(merged, []Range{{0, 200000}, {800000, Scale}}) || !reflect.DeepEqual(input, before) {
		t.Fatal(merged, err, input)
	}
	for _, invalid := range []Range{{-1, 1}, {0, Scale + 1}, {1, 1}, {2, 1}} {
		p := sample()
		p.Coverage.Ranges = []Range{invalid}
		if Valid(p) {
			t.Fatal("invalid range accepted", invalid)
		}
	}
	for _, encoded := range []string{`[]`, `[0]`, `[0,1,2]`, `null`, `[null,1]`, `[0,null]`, `[0,1.2]`, `[0,"1"]`} {
		var r Range
		if json.Unmarshal([]byte(encoded), &r) == nil {
			t.Fatal("invalid encoding accepted", encoded)
		}
	}
	for _, key := range []string{"", "bad\x00key", strings.Repeat("a", 201)} {
		p := sample()
		p.Coverage.Paragraph = key
		if Valid(p) {
			t.Fatal("invalid key accepted")
		}
	}
	p := sample()
	p.OperationID = "bad"
	if Valid(p) {
		t.Fatal("invalid UUID")
	}
	p = sample()
	p.Coverage.Ranges = nil
	if Valid(p) {
		t.Fatal("empty observation accepted")
	}
	p.Coverage.Ranges = make([]Range, MaxIncomingRanges+1)
	for i := range p.Coverage.Ranges {
		p.Coverage.Ranges[i] = Range{0, 1}
	}
	if Valid(p) {
		t.Fatal("unbounded incoming observations")
	}
	fragments := make([]Range, MaxStoredRanges+1)
	for i := range fragments {
		fragments[i] = Range{i * 2, i*2 + 1}
	}
	if _, err = Merge(fragments); !errors.Is(err, ErrFragmentLimit) {
		t.Fatal(err)
	}
	// A bridging observation can reduce a fragmented paragraph again.
	if got, err := Merge(append(fragments, Range{0, Scale})); err != nil || !reflect.DeepEqual(got, []Range{{0, Scale}}) {
		t.Fatal(got, err)
	}
}

func TestPostgresCoverage(t *testing.T) {
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
	apply := func(owner string, change Change) Coverage {
		t.Helper()
		result, err := store.Apply(ctx, owner, change)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := sample()
	initial := apply(a, first)
	bridge := first
	bridge.OperationID = newID()
	bridge.Coverage.Ranges = []Range{{200000, 400000}}
	apply(a, bridge)
	if retried := apply(a, first); !reflect.DeepEqual(retried, initial) {
		t.Fatal("receipt must be original snapshot", retried)
	}
	changed := first
	changed.Coverage.Ranges = []Range{{0, Scale}}
	if _, err := store.Apply(ctx, a, changed); !errors.Is(err, ErrOperationReused) {
		t.Fatal("payload collision", err)
	}
	// Same operation UUID is private to an owner.
	apply(b, first)
	page, err := store.List(ctx, b, first.Coverage.BookID, "1", "", 20)
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], initial) {
		t.Fatal("owner isolation", page, err)
	}

	// Concurrent devices union fragments, preserving gaps and unrelated paragraphs.
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for i := range 12 {
		wg.Go(func() {
			p := sample()
			p.Coverage.Paragraph = "concurrent"
			p.Coverage.Ranges = []Range{{i * 100, i*100 + 50}}
			_, err := store.Apply(ctx, a, p)
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	// Parallel retries of one uncertain operation yield one receipt.
	duplicate := sample()
	duplicate.Coverage.Paragraph = "duplicate"
	retries := make(chan error, 8)
	for range 8 {
		wg.Go(func() { _, err := store.Apply(ctx, a, duplicate); retries <- err })
	}
	wg.Wait()
	close(retries)
	for err := range retries {
		if err != nil {
			t.Fatal(err)
		}
	}
	var receipts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, a, duplicate.OperationID).Scan(&receipts); err != nil || receipts != 1 {
		t.Fatal(receipts, err)
	}
	page, err = store.List(ctx, a, first.Coverage.BookID, "1", "", 1)
	if err != nil || len(page.Items) != 1 || page.NextCursor != first.Coverage.Paragraph || !reflect.DeepEqual(page.Items[0].Ranges, []Range{{0, 400000}, {800000, Scale}}) {
		t.Fatal(page, err)
	}
	second, err := store.List(ctx, a, first.Coverage.BookID, "1", page.NextCursor, 1)
	if err != nil || len(second.Items) != 1 || len(second.Items[0].Ranges) != 12 || second.NextCursor != "concurrent" {
		t.Fatal(second, err)
	}
	last, err := store.List(ctx, a, first.Coverage.BookID, "1", second.NextCursor, 1)
	if err != nil || len(last.Items) != 1 || last.Items[0].Paragraph != "duplicate" || last.NextCursor != "" {
		t.Fatal(last, err)
	}
	empty, err := store.List(ctx, a, first.Coverage.BookID, "old", "", 20)
	if err != nil || len(empty.Items) != 0 || empty.Items == nil {
		t.Fatal("edition isolation", empty, err)
	}
	for _, limit := range []int{0, 51} {
		if _, err := store.List(ctx, a, "book", "1", "", limit); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
	}

	// Receipt kinds share a namespace in both directions.
	timer := readingsessions.Change{OperationID: first.OperationID, Session: readingsessions.Report{SessionID: newID(), DeviceID: newID(), BookID: "room-for-stories", Version: "1", Day: "2026-11-13", Milliseconds: 1}}
	timeStore := readingsessions.Postgres{Pool: pool}
	if _, err := timeStore.Apply(ctx, a, timer); !errors.Is(err, readingsessions.ErrOperationReused) {
		t.Fatal(err)
	}
	timer.OperationID = newID()
	if _, err := timeStore.Apply(ctx, a, timer); err != nil {
		t.Fatal(err)
	}
	collision := sample()
	collision.OperationID = timer.OperationID
	if _, err := store.Apply(ctx, a, collision); !errors.Is(err, ErrOperationReused) {
		t.Fatal(err)
	}

	// FK failure leaves no receipt. Excess fragmentation leaves existing data intact.
	invalid := sample()
	invalid.Coverage.Version = "missing"
	if _, err := store.Apply(ctx, a, invalid); err == nil {
		t.Fatal("missing edition accepted")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, a, invalid.OperationID).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
	fragmented := sample()
	fragmented.Coverage.Paragraph = "fragmented"
	for batch := range 4 {
		fragmented.OperationID = newID()
		fragmented.Coverage.Ranges = nil
		for i := range 64 {
			start := (batch*64 + i) * 2
			fragmented.Coverage.Ranges = append(fragmented.Coverage.Ranges, Range{start, start + 1})
		}
		apply(a, fragmented)
	}
	fragmented.OperationID = newID()
	fragmented.Coverage.Ranges = []Range{{1000, 1001}}
	if _, err := store.Apply(ctx, a, fragmented); !errors.Is(err, ErrFragmentLimit) {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM processed_operations WHERE user_id=$1 AND operation_id=$2`, a, fragmented.OperationID).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}

	// Force receipt insertion to fail after coverage mutation, then retry safely.
	role := "coverage_fail_" + strings.ReplaceAll(newID(), "-", "")
	if _, err := pool.Exec(ctx, `CREATE ROLE `+role); err != nil {
		t.Fatal(err)
	}
	defer func() { pool.Exec(ctx, `DROP OWNED BY `+role); pool.Exec(ctx, `DROP ROLE `+role) }()
	if _, err := pool.Exec(ctx, `GRANT USAGE ON SCHEMA public TO `+role+`; GRANT SELECT,UPDATE ON users TO `+role+`; GRANT SELECT,INSERT,UPDATE ON reading_coverage TO `+role+`; GRANT SELECT ON processed_operations TO `+role); err != nil {
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
	fail := sample()
	fail.Coverage.Ranges = []Range{{400000, 600000}}
	_, err = (Postgres{Pool: restricted}).Apply(ctx, a, fail)
	restricted.Close()
	var denied *pgconn.PgError
	if !errors.As(err, &denied) || denied.Code != "42501" || !strings.Contains(denied.Message, "processed_operations") {
		t.Fatal("expected receipt failure", err)
	}
	var raw []byte
	var after []Range
	if err := pool.QueryRow(ctx, `SELECT ranges FROM reading_coverage WHERE user_id=$1 AND book_id=$2 AND book_version=$3 AND paragraph=$4`, a, fail.Coverage.BookID, fail.Coverage.Version, fail.Coverage.Paragraph).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &after); err != nil || !reflect.DeepEqual(after, []Range{{0, 400000}, {800000, Scale}}) {
		t.Fatal("partial update", after, err)
	}
	apply(a, fail)
	deleted := user()
	if _, err := pool.Exec(ctx, `UPDATE users SET deleted_at=now() WHERE id=$1`, deleted); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, deleted, sample()); err == nil {
		t.Fatal("deleted owner accepted")
	}
}
