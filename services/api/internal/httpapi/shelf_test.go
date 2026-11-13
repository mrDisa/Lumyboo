package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"lumyboo/services/api/internal/auth"
	"lumyboo/services/api/internal/shelf"
)

type shelfMemory struct {
	owner string
	ids   []string
	calls int
}

func (s *shelfMemory) List(_ context.Context, owner string) ([]string, error) {
	s.owner = owner
	return s.ids, nil
}
func (s *shelfMemory) Import(_ context.Context, owner string, ids []string) ([]string, error) {
	s.owner = owner
	s.calls++
	s.ids = ids
	return ids, nil
}
func shelfServer(t *testing.T, store shelf.Store) (http.Handler, string, sessionView) {
	t.Helper()
	service, err := auth.New(httpStore{}, httpMailer{}, []byte(strings.Repeat("s", 32)))
	if err != nil {
		t.Fatal(err)
	}
	handler := New(nil, AuthOptions{Service: service, Shelf: store, Origin: "https://lumyboo.example"})
	login := authRequest(handler, "POST", "/api/v1/auth/verify", `{"challengeId":"`+strings.Repeat("a", 43)+`","code":"123456"}`, "https://lumyboo.example", "", "")
	if login.Code != 200 {
		t.Fatal(login.Code, login.Body)
	}
	cookie := login.Result().Cookies()[0]
	var session sessionView
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	return handler, cookie.Name + "=" + cookie.Value, session
}
func TestShelfImportSecurityAndValidation(t *testing.T) {
	store := &shelfMemory{ids: []string{}}
	handler, cookie, session := shelfServer(t, store)
	body := `{"accountId":"` + session.User.ID + `","bookIds":["room-for-stories","room-for-stories"]}`
	for _, tc := range []struct {
		name, body, cookie, csrf, origin string
		status                           int
	}{
		{"guest", body, "", "", "https://lumyboo.example", 401},
		{"csrf", body, cookie, "", "https://lumyboo.example", 403},
		{"origin", body, cookie, session.CSRFToken, "https://evil.example", 403},
		{"changed account", strings.Replace(body, session.User.ID, "00000000-0000-4000-8000-000000000002", 1), cookie, session.CSRFToken, "https://lumyboo.example", 409},
		{"unknown book", strings.ReplaceAll(body, "room-for-stories", "not-a-book"), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"unknown field", `{"accountId":"` + session.User.ID + `","bookIds":["room-for-stories"],"userId":"other"}`, cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"empty", `{"accountId":"` + session.User.ID + `","bookIds":[]}`, cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"oversized", `{"accountId":"` + session.User.ID + `","bookIds":["` + strings.Repeat("x", 2200) + `"]}`, cookie, session.CSRFToken, "https://lumyboo.example", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := authRequest(handler, "POST", "/api/v1/shelf/import", tc.body, tc.origin, tc.cookie, tc.csrf)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body)
			}
		})
	}
	if store.calls != 0 {
		t.Fatal("invalid request wrote data")
	}
	w := authRequest(handler, "POST", "/api/v1/shelf/import", body, "https://lumyboo.example", cookie, session.CSRFToken)
	if w.Code != 200 || store.owner != session.User.ID || len(store.ids) != 1 || store.ids[0] != "room-for-stories" {
		t.Fatal("import failed", w.Code, w.Body, store)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private shelf cacheable")
	}
	w = authRequest(handler, "GET", "/api/v1/shelf/", "", "", cookie, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), session.User.ID) {
		t.Fatal(w.Code, w.Body)
	}
	if guest := authRequest(handler, "GET", "/api/v1/shelf/", "", "", "", ""); guest.Code != 401 {
		t.Fatal("guest shelf visible")
	}
}

func TestPostgresShelfImportPreservesBooksAndIsolatesOwners(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL integration")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	makeUser := func() string {
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
	// Pool cleanup must run after user cleanup.
	t.Cleanup(pool.Close)
	a, b := makeUser(), makeUser()
	store := shelf.Postgres{Pool: pool}
	if _, err := store.Import(ctx, a, []string{"existing"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Import(ctx, b, []string{"private"}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.Import(ctx, a, []string{"room-for-stories", "room-for-stories"})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	ids, err := store.List(ctx, a)
	if err != nil || strings.Join(ids, ",") != "existing,room-for-stories" {
		t.Fatal("merge or replay failed", ids, err)
	}
	ids, err = store.List(ctx, b)
	if err != nil || strings.Join(ids, ",") != "private" {
		t.Fatal("another owner changed", ids, err)
	}
}
