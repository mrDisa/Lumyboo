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

func TestPostgresChallengeInvitationJourney(t *testing.T) {
	pool := journeyDatabase(t)
	mailbox, device := journeyServer(t, pool)
	a, b, c := device(), device(), device()
	a.login("invite-owner@example.test", mailbox)
	b.login("invite-reader@example.test", mailbox)
	c.login("invite-outsider@example.test", mailbox)
	input := map[string]any{"accountId": a.session.User.ID, "operationId": journeyID(t), "name": "Friends", "nickname": "Owner", "mode": "competitive", "startDay": time.Now().UTC().AddDate(0, 0, 1).Format("2006-01-02"), "duration": 7, "timeZone": "UTC", "minutes": 30}
	id := a.request("POST", "/challenges", input, 200)["challenge"].(map[string]any)["id"].(string)
	action := func(d *journeyDevice, kind string, code string, status int) map[string]any {
		return d.request("POST", "/challenges/action", map[string]any{"accountId": d.session.User.ID, "kind": kind, "challengeId": id, "code": code, "nickname": "Friend", "minutes": 5}, status)
	}
	invitation := action(a, "invite", "", 200)
	code := invitation["code"].(string)
	journeyEqual(t, action(a, "invite", "", 200), invitation)
	action(b, "invite", "", 409)
	action(b, "leave", "", 409)
	preview := action(b, "preview", code, 200)["challenge"].(map[string]any)
	journeyEqual(t, preview["members"], []any{})
	journeyEqual(t, preview["minutes"], 30)
	joined := action(b, "join", code, 200)
	journeyEqual(t, joined["challenge"].(map[string]any)["minutes"], 30)
	journeyEqual(t, action(b, "join", code, 200), joined)
	list := b.request("GET", "/challenges?accountId="+b.session.User.ID, nil, 200)["items"].([]any)
	journeyEqual(t, len(list), 1)
	members := list[0].(map[string]any)["members"].([]any)
	journeyEqual(t, len(members), 2)
	for _, m := range members {
		for key := range m.(map[string]any) {
			if key != "nickname" && key != "minutes" && key != "left" {
				t.Fatal("private member field", key)
			}
		}
	}
	action(b, "revoke", "", 409)
	action(a, "revoke", "", 200)
	action(a, "revoke", "", 200)
	action(c, "preview", code, 409)
	action(c, "join", code, 409)
	journeyEqual(t, action(b, "join", code, 200), joined)
	left := action(b, "leave", "", 200)
	journeyEqual(t, left["challenge"].(map[string]any)["left"], true)
	journeyEqual(t, action(b, "leave", "", 200), left)
	journeyEqual(t, action(b, "join", code, 200), left)
	newCode := action(a, "invite", "", 200)["code"].(string)
	if code == newCode {
		t.Fatal("revoked code reused")
	}
	action(c, "preview", newCode, 200)
	csrf := a.session.CSRFToken
	a.session.CSRFToken = "invalid"
	action(a, "revoke", "", 403)
	a.session.CSRFToken = csrf
	b.request("POST", "/challenges/action", map[string]any{"accountId": a.session.User.ID, "kind": "preview", "code": newCode}, 409)
	action(a, "leave", "", 200)
	action(c, "join", newCode, 409)
}

func TestPostgresChallengeInvitationCapacityAndStart(t *testing.T) {
	pool := journeyDatabase(t)
	mailbox, device := journeyServer(t, pool)
	a := device()
	a.login("capacity-owner@example.test", mailbox)
	ctx := context.Background()
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	store := challenges.Postgres{Pool: pool, Now: func() time.Time { return now }}
	create := challenges.Create{OperationID: journeyID(t), Name: "Capacity", Nickname: "Owner", Mode: "personal", StartDay: "2026-11-16", Duration: 14, TimeZone: "UTC", Minutes: 20}
	challenge, err := store.Create(ctx, a.session.User.ID, create)
	if err != nil {
		t.Fatal(err)
	}
	invite, err := store.Action(ctx, a.session.User.ID, challenges.Action{Kind: "invite", ChallengeID: challenge.ID})
	if err != nil {
		t.Fatal(err)
	}
	users := []string{}
	for i := 0; i < 11; i++ {
		var id string
		if err = pool.QueryRow(ctx, `INSERT INTO users(id) VALUES($1) RETURNING id::text`, journeyID(t)).Scan(&id); err != nil {
			t.Fatal(err)
		}
		users = append(users, id)
	}
	var wg sync.WaitGroup
	success := make(chan string, 11)
	failures := make(chan error, 11)
	for _, id := range users {
		wg.Add(1)
		go func(user string) {
			defer wg.Done()
			_, e := store.Action(ctx, user, challenges.Action{Kind: "join", Code: invite.Code, Nickname: "Reader", Minutes: 5})
			if e == nil {
				success <- user
			} else {
				failures <- e
			}
		}(id)
	}
	wg.Wait()
	close(success)
	close(failures)
	joined := []string{}
	for id := range success {
		joined = append(joined, id)
	}
	if len(joined) != 9 {
		t.Fatalf("accepted %d", len(joined))
	}
	for e := range failures {
		if e != challenges.ErrFull {
			t.Fatal(e)
		}
	}
	items, err := store.List(ctx, joined[0])
	if err != nil || len(items) != 1 || items[0].Minutes != 5 {
		t.Fatalf("personal target %+v %v", items, err)
	}
	_, err = store.Action(ctx, joined[0], challenges.Action{Kind: "leave", ChallengeID: challenge.ID})
	if err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	for _, id := range users {
		found := false
		for _, j := range joined {
			if id == j {
				found = true
			}
		}
		if !found {
			_, e := store.Action(ctx, id, challenges.Action{Kind: "join", Code: invite.Code, Nickname: "Reader", Minutes: 10})
			if e != challenges.ErrUnavailable {
				t.Fatal(e)
			}
		}
	}
	_, err = store.Action(ctx, joined[1], challenges.Action{Kind: "join", Code: invite.Code, Nickname: "Changed", Minutes: 60})
	if err != nil {
		t.Fatal(err)
	}
	items, err = store.List(ctx, joined[1])
	if err != nil || items[0].Minutes != 5 || items[0].Nickname != "Reader" {
		t.Fatalf("retry changed membership %+v %v", items, err)
	}
}
