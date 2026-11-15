package httpapi

import (
	"context"
	"lumyboo/services/api/internal/challenges"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestPostgresChallengesCreateAndPrivacy(t *testing.T) {
	pool := journeyDatabase(t)
	mailbox, device := journeyServer(t, pool)
	a, b, guest := device(), device(), device()
	guest.request("GET", "/challenges?accountId=x", nil, 401)
	a.login("challenge-a@example.test", mailbox)
	b.login("challenge-b@example.test", mailbox)
	path := "/challenges?accountId=" + a.session.User.ID
	journeyEqual(t, a.request("GET", path, nil, 200)["items"], []any{})
	b.request("GET", path, nil, 409)
	input := map[string]any{"accountId": a.session.User.ID, "operationId": journeyID(t), "name": "Читаем вместе", "nickname": "Читатель", "mode": "competitive", "startDay": time.Now().UTC().AddDate(0, 0, 1).Format("2006-01-02"), "duration": 7, "timeZone": "UTC", "minutes": 20}
	first := a.request("POST", "/challenges", input, 200)
	journeyEqual(t, a.request("POST", "/challenges", input, 200), first)
	item := first["challenge"].(map[string]any)
	journeyEqual(t, a.request("GET", path, nil, 200)["items"], []any{item})
	if _, exists := item["ownerId"]; exists {
		t.Fatal("owner exposed")
	}
	journeyEqual(t, b.request("GET", "/challenges?accountId="+b.session.User.ID, nil, 200)["items"], []any{})
	b.request("POST", "/challenges", input, 409)
	csrf := a.session.CSRFToken
	a.session.CSRFToken = "invalid"
	a.request("POST", "/challenges", input, 403)
	a.session.CSRFToken = csrf
	input["minutes"] = 5
	a.request("POST", "/challenges", input, 409)
	input["operationId"] = journeyID(t)
	input["mode"] = "personal"
	input["duration"] = 30
	a.request("POST", "/challenges", input, 200)
	for _, pair := range []struct {
		field string
		value any
	}{{"minutes", 1}, {"mode", "fast-track"}, {"duration", 8}, {"timeZone", "Local"}, {"timeZone", "invalid"}, {"startDay", "2026-02-30"}, {"startDay", time.Now().UTC().Format("2006-01-02")}, {"name", " "}, {"nickname", "with\nnewline"}} {
		old := input[pair.field]
		input[pair.field] = pair.value
		input["operationId"] = journeyID(t)
		a.request("POST", "/challenges", input, 400)
		input[pair.field] = old
	}
	req, _ := http.NewRequest("GET", a.origin+"/api/v1"+path, nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	res, err := a.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal(res.StatusCode)
	}
	var members, created int
	if err = pool.QueryRow(context.Background(), `SELECT count(*) FROM challenges`).Scan(&created); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(context.Background(), `SELECT count(*) FROM challenge_members`).Scan(&members); err != nil || created != 2 || members != 2 {
		t.Fatalf("%d %d %v", created, members, err)
	}
}
func TestPostgresChallengeConcurrentRetryAndFixedConditions(t *testing.T) {
	pool := journeyDatabase(t)
	mailbox, device := journeyServer(t, pool)
	a := device()
	a.login("fixed-challenge@example.test", mailbox)
	now := time.Date(2026, 3, 7, 12, 0, 0, 0, time.UTC)
	store := challenges.Postgres{Pool: pool, Now: func() time.Time { return now }}
	input := challenges.Create{OperationID: journeyID(t), Name: "Fixed", Nickname: "Reader", Mode: "competitive", StartDay: "2026-03-08", Duration: 14, TimeZone: "America/New_York", Minutes: 30}
	ctx := context.Background()
	owner := a.session.User.ID
	var wg sync.WaitGroup
	ids := make(chan string, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := store.Create(ctx, owner, input)
			if err != nil {
				t.Error(err)
				return
			}
			ids <- c.ID
		}()
	}
	wg.Wait()
	close(ids)
	id := ""
	for got := range ids {
		if id != "" && got != id {
			t.Fatal("duplicate")
		}
		id = got
	}
	now = now.AddDate(0, 0, 3)
	retry, err := store.Create(ctx, owner, input)
	if err != nil || retry.ID != id {
		t.Fatalf("%+v %v", retry, err)
	}
	input.OperationID = journeyID(t)
	if _, err = store.Create(ctx, owner, input); err != challenges.ErrInvalid {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO daily_goal_settings(user_id,time_zone,revision) VALUES($1,'UTC',1)`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO daily_goal_changes(user_id,effective_from,minutes) VALUES($1,'2026-03-07',5)`, owner); err != nil {
		t.Fatal(err)
	}
	items, err := store.List(ctx, owner)
	if err != nil || len(items) != 1 || items[0].Minutes != 30 || items[0].TimeZone != "America/New_York" {
		t.Fatalf("%+v %v", items, err)
	}
}
