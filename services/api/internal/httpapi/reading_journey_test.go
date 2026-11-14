package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"lumyboo/services/api/internal/auth"
	"lumyboo/services/api/internal/bookmarks"
	"lumyboo/services/api/internal/positions"
	"lumyboo/services/api/internal/readingcoverage"
	"lumyboo/services/api/internal/readingsessions"
	"lumyboo/services/api/internal/shelf"
)

// Only delivery is replaced: codes are generated, hashed, consumed and checked
// through the real auth service and PostgreSQL. No fixed-code login bypass.
type journeyMailbox struct {
	mu    sync.Mutex
	codes map[string]string
}

func (m *journeyMailbox) SendCode(_ context.Context, email, code string, _ time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.codes[email] = code
	return nil
}
func journeyID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// Apply the real migrations in a disposable schema. Existing local or CI data
// is never truncated or migrated. Requires permission to create a schema.
func journeyDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL integration")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	schema := "journey_" + strings.ReplaceAll(journeyID(t), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	files, err := filepath.Glob("../../db/migrations/*.up.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("migrations: %v (%d files)", err, len(files))
	}
	for _, file := range files {
		sql, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
	}
	return pool
}

type journeyDevice struct {
	t       *testing.T
	client  *http.Client
	origin  string
	session sessionView
}

func (d *journeyDevice) request(method, path string, body any, status int) map[string]any {
	d.t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			d.t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, d.origin+"/api/v1"+path, bytes.NewReader(data))
	if err != nil {
		d.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", d.origin)
	req.Header.Set("X-CSRF-Token", d.session.CSRFToken)
	response, err := d.client.Do(req)
	if err != nil {
		d.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		d.t.Fatal(err)
	}
	if response.StatusCode != status {
		d.t.Fatalf("%s %s: got %d, want %d: %s", method, path, response.StatusCode, status, raw)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		d.t.Fatalf("%s: private response can be cached", path)
	}
	var result map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &result); err != nil {
			d.t.Fatal(err)
		}
	}
	return result
}
func (d *journeyDevice) login(email string, mailbox *journeyMailbox) {
	d.t.Helper()
	issued := d.request("POST", "/auth/code", map[string]any{"email": email}, 202)
	mailbox.mu.Lock()
	code := mailbox.codes[email]
	mailbox.mu.Unlock()
	result := d.request("POST", "/auth/verify", map[string]any{"challengeId": issued["challengeId"], "code": code}, 200)
	raw, _ := json.Marshal(result)
	if err := json.Unmarshal(raw, &d.session); err != nil {
		d.t.Fatal(err)
	}
	if d.session.User.ID == "" || d.session.CSRFToken == "" {
		d.t.Fatal("missing session")
	}
}
func journeyEqual(t *testing.T, got, want any) {
	t.Helper()
	// Compare JSON values, including numeric values returned by the HTTP decoder.
	a, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var av, bv any
	if err := json.Unmarshal(a, &av); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(av, bv) {
		t.Fatalf("got %s, want %s", a, b)
	}
}

func journeyServer(t *testing.T, pool *pgxpool.Pool, wrappers ...func(http.Handler) http.Handler) (*journeyMailbox, func() *journeyDevice) {
	t.Helper()
	mailbox := &journeyMailbox{codes: map[string]string{}}
	service, err := auth.New(auth.NewPostgres(pool), mailbox, []byte(strings.Repeat("s", 32)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(nil)
	origin := "https://" + server.Listener.Addr().String()
	server.Config.Handler = New(PostgresReadiness{Pool: pool}, AuthOptions{
		Service: service, Origin: origin, SecureCookies: true,
		Shelf: shelf.Postgres{Pool: pool}, Positions: positions.Postgres{Pool: pool},
		Bookmarks: bookmarks.Postgres{Pool: pool}, ReadingSessions: readingsessions.Postgres{Pool: pool},
		ReadingCoverage: readingcoverage.Postgres{Pool: pool},
	})
	for _, wrap := range wrappers {
		server.Config.Handler = wrap(server.Config.Handler)
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	device := func() *journeyDevice {
		jar, err := cookiejar.New(nil)
		if err != nil {
			t.Fatal(err)
		}
		client := *server.Client()
		client.Jar = jar
		client.Timeout = 10 * time.Second
		return &journeyDevice{t: t, client: &client, origin: origin}
	}
	return mailbox, device
}

func TestPostgresReadingJourneyTwoSessions(t *testing.T) {
	pool := journeyDatabase(t)
	mailbox, device := journeyServer(t, pool)
	a, b, other, guest := device(), device(), device(), device()
	guest.request("GET", "/positions/", nil, 401)
	a.login("reader@example.test", mailbox)
	// Advance only the persisted resend gate, avoiding a minute-long test sleep.
	// The second device still requests and verifies its own one-time code.
	b.request("POST", "/auth/code", map[string]any{"email": "reader@example.test"}, 429)
	if _, err := pool.Exec(context.Background(), "UPDATE auth_email_state SET last_requested_at=now()-interval '61 seconds'"); err != nil {
		t.Fatal(err)
	}
	b.login("reader@example.test", mailbox)
	journeyEqual(t, b.session.User, a.session.User)
	if b.session.CSRFToken == a.session.CSRFToken {
		t.Fatal("devices share a session")
	}
	other.login("other@example.test", mailbox)
	owner := a.session.User.ID

	entry := bookmarks.Entry{BookID: "room-for-stories", Version: "1", Chapter: 0, Paragraph: "ch-1-p-1", Offset: .25, Label: "Guest bookmark"}
	imported := map[string]any{"accountId": owner, "bookIds": []string{entry.BookID}}
	a.request("POST", "/shelf/import", imported, 200)
	a.request("POST", "/shelf/import", imported, 200)
	journeyEqual(t, b.request("GET", "/shelf/", nil, 200)["bookIds"], []string{entry.BookID})
	bookmarkImport := map[string]any{"accountId": owner, "bookmarks": []bookmarks.Entry{entry}}
	a.request("POST", "/bookmarks/import", bookmarkImport, 200)
	a.request("POST", "/bookmarks/import", bookmarkImport, 200)
	journeyEqual(t, b.request("GET", "/bookmarks/", nil, 200)["bookmarks"], []bookmarks.Entry{entry})

	initial := positions.Locator{BookID: entry.BookID, Version: entry.Version, Chapter: 0, Paragraph: entry.Paragraph, Offset: .25}
	choice := map[string]any{"accountId": owner, "operationId": journeyID(t), "expectedRevision": 0, "position": initial}
	saved := a.request("POST", "/positions/choose", choice, 200)
	journeyEqual(t, a.request("POST", "/positions/choose", choice, 200), saved) // Lost response retry.
	journeyEqual(t, b.request("GET", "/positions/", nil, 200)["positions"], []any{saved["position"]})
	continued := initial
	continued.Chapter = 1
	continued.Paragraph = "ch-2-p-1"
	continued.Offset = .6
	next := map[string]any{"accountId": owner, "operationId": journeyID(t), "expectedRevision": 1, "position": continued}
	advanced := b.request("POST", "/positions/choose", next, 200)
	stale := map[string]any{"accountId": owner, "operationId": journeyID(t), "expectedRevision": 1, "position": initial}
	journeyEqual(t, a.request("POST", "/positions/choose", stale, 409)["error"].(map[string]any)["code"], "position_conflict")
	journeyEqual(t, a.request("POST", "/positions/choose", choice, 200), saved)
	journeyEqual(t, a.request("GET", "/positions/", nil, 200)["positions"], []any{advanced["position"]})

	deletion := map[string]any{"accountId": owner, "operationId": journeyID(t), "expectedRevision": 1, "bookmark": entry, "deleted": true}
	deleted := b.request("POST", "/bookmarks/apply", deletion, 200)
	journeyEqual(t, b.request("POST", "/bookmarks/apply", deletion, 200), deleted)
	a.request("POST", "/bookmarks/import", bookmarkImport, 200)
	journeyEqual(t, a.request("GET", "/bookmarks/", nil, 200)["bookmarks"], []any{})
	journeyEqual(t, a.request("GET", "/bookmarks/state", nil, 200)["bookmarks"], []any{deleted["bookmark"]})

	report := readingsessions.Report{SessionID: journeyID(t), DeviceID: journeyID(t), BookID: entry.BookID, Version: entry.Version, Day: "2026-11-14", Milliseconds: 60000}
	batch := map[string]any{"accountId": owner, "operationId": journeyID(t), "session": report}
	firstTime := a.request("POST", "/reading-sessions/apply", batch, 200)
	report.Milliseconds = 90000
	a.request("POST", "/reading-sessions/apply", map[string]any{"accountId": owner, "operationId": journeyID(t), "session": report}, 200)
	journeyEqual(t, a.request("POST", "/reading-sessions/apply", batch, 200), firstTime)
	latest := b.request("GET", "/reading-sessions/"+report.SessionID, nil, 200)["session"].(map[string]any)
	journeyEqual(t, latest["milliseconds"], 90000)
	secondReport := report
	secondReport.SessionID = journeyID(t)
	secondReport.DeviceID = journeyID(t)
	secondReport.Milliseconds = 30000
	b.request("POST", "/reading-sessions/apply", map[string]any{"accountId": owner, "operationId": journeyID(t), "session": secondReport}, 200)
	history := a.request("GET", "/reading-sessions/?limit=20", nil, 200)["items"].([]any)
	var total float64
	for _, item := range history {
		total += item.(map[string]any)["milliseconds"].(float64)
	}
	journeyEqual(t, total, 120000)
	journeyEqual(t, len(history), 2)

	fragment := readingcoverage.Coverage{BookID: entry.BookID, Version: entry.Version, Paragraph: entry.Paragraph, Ranges: []readingcoverage.Range{{0, 600000}}}
	coverageBatch := map[string]any{"accountId": owner, "operationId": journeyID(t), "coverage": fragment}
	a.request("POST", "/reading-coverage/apply", coverageBatch, 200)
	fragment.Ranges = []readingcoverage.Range{{400000, 1000000}}
	b.request("POST", "/reading-coverage/apply", map[string]any{"accountId": owner, "operationId": journeyID(t), "coverage": fragment}, 200)
	a.request("POST", "/reading-coverage/apply", coverageBatch, 200)
	fragment.Ranges = []readingcoverage.Range{{0, 1000000}}
	journeyEqual(t, a.request("GET", "/reading-coverage/room-for-stories?version=1", nil, 200)["items"], []readingcoverage.Coverage{fragment})

	// Another user and a stale tab cannot read or mutate the first account.
	for path, key := range map[string]string{"/positions/": "positions", "/bookmarks/state": "bookmarks", "/shelf/": "bookIds", "/reading-sessions/": "items", "/reading-coverage/room-for-stories?version=1": "items"} {
		journeyEqual(t, other.request("GET", path, nil, 200)[key], []any{})
	}
	other.request("GET", "/reading-sessions/"+report.SessionID, nil, 404)
	other.request("POST", "/positions/choose", next, 409)
	other.request("POST", "/reading-sessions/apply", batch, 409)
	a.request("POST", "/auth/logout", nil, 204)
	a.request("GET", "/positions/", nil, 401)
	b.request("GET", "/positions/", nil, 200) // Logging out A does not revoke B.
	if _, err := pool.Exec(context.Background(), "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", owner); err != nil {
		t.Fatal(err)
	}
	b.request("POST", "/reading-sessions/apply", batch, 401)
	var milliseconds int64
	if err := pool.QueryRow(context.Background(), "SELECT sum(milliseconds) FROM reading_sessions WHERE user_id=$1", owner).Scan(&milliseconds); err != nil {
		t.Fatal(err)
	}
	journeyEqual(t, milliseconds, 120000)
}

// A reachable database with an older schema must not accept traffic as ready.
func TestPostgresReadinessRequiresAccountSchema(t *testing.T) {
	pool := journeyDatabase(t)
	handler := New(PostgresReadiness{Pool: pool})
	check := func(path string, status int) {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != status {
			t.Fatalf("%s: got %d, want %d: %s", path, response.Code, status, response.Body)
		}
	}
	check("/readyz", 200)
	if _, err := pool.Exec(context.Background(), "ALTER TABLE bookmarks DROP COLUMN server_revision"); err != nil {
		t.Fatal(err)
	}
	check("/readyz", 503)
	check("/healthz", 200)
	if _, err := pool.Exec(context.Background(), "ALTER TABLE bookmarks ADD COLUMN server_revision bigint NOT NULL DEFAULT 1"); err != nil {
		t.Fatal(err)
	}
	check("/readyz", 200)
	if _, err := pool.Exec(context.Background(), "DROP TABLE reading_coverage"); err != nil {
		t.Fatal(err)
	}
	check("/readyz", 503)
	check("/healthz", 200)
}
