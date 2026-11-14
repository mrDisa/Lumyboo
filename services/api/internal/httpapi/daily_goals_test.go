package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"lumyboo/services/api/internal/dailygoals"
)

func TestPostgresDailyGoalTwoDevices(t *testing.T) {
	pool := journeyDatabase(t)
	mailbox, device := journeyServer(t, pool)
	a, b, other, guest := device(), device(), device(), device()
	guest.request("GET", "/daily-goal", nil, 401)
	a.login("goals@example.test", mailbox)
	if _, err := pool.Exec(context.Background(), "UPDATE auth_email_state SET last_requested_at=now()-interval '61 seconds'"); err != nil {
		t.Fatal(err)
	}
	b.login("goals@example.test", mailbox)
	other.login("other-goals@example.test", mailbox)
	a.request("GET", "/daily-goal", nil, 404)
	today := time.Now().UTC().Format("2006-01-02")
	tomorrow := time.Now().UTC().AddDate(0, 0, 1).Format("2006-01-02")
	body := map[string]any{"accountId": a.session.User.ID, "operationId": journeyID(t), "expectedRevision": 0, "timeZone": "UTC", "from": tomorrow, "minutes": 5}
	first := a.request("POST", "/daily-goal", body, 200)
	journeyEqual(t, b.request("GET", "/daily-goal", nil, 200)["goal"], first["goal"])
	journeyEqual(t, a.request("POST", "/daily-goal", body, 200), first)
	other.request("GET", "/daily-goal", nil, 404)
	other.request("POST", "/daily-goal", body, 409)
	stale := map[string]any{"accountId": a.session.User.ID, "operationId": journeyID(t), "expectedRevision": 0, "timeZone": "UTC", "from": tomorrow, "minutes": 30}
	b.request("POST", "/daily-goal", stale, 409)
	stale["expectedRevision"] = 1
	saved := b.request("POST", "/daily-goal", stale, 200)
	journeyEqual(t, a.request("POST", "/daily-goal", body, 200)["goal"], saved["goal"])
	stale["operationId"] = journeyID(t)
	stale["expectedRevision"] = 2
	stale["from"] = today
	a.request("POST", "/daily-goal", stale, 400)
	stale["from"] = tomorrow
	stale["timeZone"] = "America/New_York"
	a.request("POST", "/daily-goal", stale, 409)
	stale["timeZone"] = "Bad/Timezone"
	a.request("POST", "/daily-goal", stale, 400)
	csrf := a.session.CSRFToken
	a.session.CSRFToken = "invalid"
	a.request("POST", "/daily-goal", body, 403)
	a.session.CSRFToken = csrf
	a.request("GET", "/daily-goal?day=2026-02-30", nil, 400)
	session := map[string]any{"sessionId": journeyID(t), "deviceId": journeyID(t), "bookId": "room-for-stories", "version": "1", "day": today, "milliseconds": 600000}
	report := map[string]any{"accountId": a.session.User.ID, "operationId": journeyID(t), "session": session}
	a.request("POST", "/reading-sessions/apply", report, 200)
	a.request("POST", "/reading-sessions/apply", report, 200)
	session["milliseconds"] = 900000
	report["operationId"] = journeyID(t)
	a.request("POST", "/reading-sessions/apply", report, 200)
	session2 := map[string]any{"sessionId": journeyID(t), "deviceId": journeyID(t), "bookId": "room-for-stories", "version": "1", "day": today, "milliseconds": 300000}
	b.request("POST", "/reading-sessions/apply", map[string]any{"accountId": a.session.User.ID, "operationId": journeyID(t), "session": session2}, 200)
	journeyEqual(t, b.request("GET", "/daily-goal?day="+today, nil, 200)["progress"], map[string]any{"day": today, "minutes": 20, "milliseconds": 1200000, "complete": true})
	journeyEqual(t, b.request("GET", "/daily-goal?day="+tomorrow, nil, 200)["progress"], map[string]any{"day": tomorrow, "minutes": 30, "milliseconds": 0, "complete": false})
	req, _ := http.NewRequest("GET", a.origin+"/api/v1/daily-goal", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	res, err := a.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal(res.StatusCode)
	}
}
func TestPostgresDailyGoalCalendarHistory(t *testing.T) {
	pool := journeyDatabase(t)
	mailbox, device := journeyServer(t, pool)
	a := device()
	a.login("calendar@example.test", mailbox)
	now := time.Date(2026, 3, 8, 4, 0, 0, 0, time.UTC)
	store := dailygoals.Postgres{Pool: pool, Now: func() time.Time { return now }}
	c := dailygoals.Change{OperationID: journeyID(t), TimeZone: "America/New_York", From: "2026-03-08", Minutes: 5, InitialChanges: []dailygoals.Target{{From: "2026-03-06", Minutes: 10}}}
	goal, err := store.Apply(context.Background(), a.session.User.ID, c)
	if err != nil {
		t.Fatal(err)
	}
	if dailygoals.Minutes(goal, "2026-03-07") != 10 {
		t.Fatal(goal)
	}
	now = time.Date(2026, 3, 9, 3, 59, 59, 0, time.UTC)
	result, err := store.Get(context.Background(), a.session.User.ID, "")
	if err != nil || result.Progress.Day != "2026-03-08" || result.Progress.Minutes != 5 {
		t.Fatalf("%+v %v", result, err)
	}
	now = now.Add(time.Second)
	c.OperationID = journeyID(t)
	c.ExpectedRevision = 1
	c.From = "2026-03-10"
	c.Minutes = 60
	c.InitialChanges = nil
	if _, err = store.Apply(context.Background(), a.session.User.ID, c); err != nil {
		t.Fatal(err)
	}
	result, err = store.Get(context.Background(), a.session.User.ID, "2026-03-08")
	if err != nil || result.Progress.Minutes != 5 {
		t.Fatalf("%+v %v", result, err)
	}
}
