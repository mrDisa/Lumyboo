package httpapi

import (
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"lumyboo/services/api/internal/challenges"
)

// Exercise the complete HTTP contract with independent cookie jars and real
// PostgreSQL stores. Only challenge time and OTP delivery are test-controlled.
func TestPostgresChallengeJourneyTwoAccounts(t *testing.T) {
	for _, mode := range []string{"competitive", "personal"} {
		t.Run(mode, func(t *testing.T) {
			pool := journeyDatabase(t)
			var clock atomic.Int64
			setDay := func(day int) { clock.Store(time.Date(2026, 3, day, 12, 0, 0, 0, time.UTC).Unix()) }
			setDay(7)
			mailbox, device := journeyServerChallenges(t, pool, challenges.Postgres{Pool: pool, Now: func() time.Time { return time.Unix(clock.Load(), 0) }})
			a, b, outsider := device(), device(), device()
			a.login("journey-team-a@example.test", mailbox)
			b.login("journey-team-b@example.test", mailbox)
			outsider.login("journey-team-c@example.test", mailbox)
			input := map[string]any{"accountId": a.session.User.ID, "operationId": journeyID(t), "name": "Seven days", "nickname": "Leaf", "mode": mode, "startDay": "2026-03-08", "duration": 7, "timeZone": "UTC", "minutes": 5}
			created := a.request("POST", "/challenges", input, 200)
			journeyEqual(t, a.request("POST", "/challenges", input, 200), created)
			id := created["challenge"].(map[string]any)["id"]
			action := func(d *journeyDevice, kind string, extra map[string]any) map[string]any {
				body := map[string]any{"accountId": d.session.User.ID, "kind": kind, "challengeId": id}
				for k, v := range extra {
					body[k] = v
				}
				return d.request("POST", "/challenges/action", body, 200)
			}
			code := action(a, "invite", nil)["code"]
			preview := action(b, "preview", map[string]any{"code": code})["challenge"].(map[string]any)
			journeyEqual(t, preview["members"], []any{})
			journeyEqual(t, preview["progress"].(map[string]any)["days"], []any{})
			join := map[string]any{"code": code, "nickname": "Line", "minutes": 10}
			joined := action(b, "join", join)
			journeyEqual(t, action(b, "join", join), joined)
			bMinutes := 5
			if mode == "personal" {
				bMinutes = 10
			}
			journeyEqual(t, joined["challenge"].(map[string]any)["minutes"], bMinutes)
			list := func(d *journeyDevice) challenges.Challenge {
				raw, err := json.Marshal(d.request("GET", "/challenges?accountId="+d.session.User.ID, nil, 200)["items"])
				if err != nil {
					t.Fatal(err)
				}
				var items []challenges.Challenge
				if err := json.Unmarshal(raw, &items); err != nil || len(items) != 1 {
					t.Fatalf("items=%s err=%v", raw, err)
				}
				return items[0]
			}
			if list(a).Progress.Status != "upcoming" {
				t.Fatal("challenge started too soon")
			}
			report := func(d *journeyDevice, book, day string, ms int) map[string]any {
				body := map[string]any{"accountId": d.session.User.ID, "operationId": journeyID(t), "session": map[string]any{"sessionId": journeyID(t), "deviceId": journeyID(t), "bookId": book, "version": "1", "day": day, "milliseconds": ms}}
				d.request("POST", "/reading-sessions/apply", body, 200)
				return body
			}
			setDay(8)
			first := report(a, "room-for-stories", "2026-03-08", 300000)
			// A repeated cumulative report must not add another day or minutes.
			a.request("POST", "/reading-sessions/apply", first, 200)
			report(b, "what-men-live-by", "2026-03-08", bMinutes*60000-1)
			assertMembers := func(aDays, bDays int, left bool, status string) {
				t.Helper()
				for _, d := range []*journeyDevice{a, b} {
					c := list(d)
					if c.Progress.Status != status || len(c.Members) != 2 {
						t.Fatalf("%+v", c)
					}
					for _, m := range c.Members {
						wantDays, wantLeft, other := bDays, false, aDays
						if m.Nickname == "Leaf" {
							wantDays, wantLeft, other = aDays, left, bDays
						} else if m.Nickname != "Line" {
							t.Fatal(m)
						}
						wantRank := 0
						if mode == "competitive" {
							wantRank = 1
							if other > wantDays {
								wantRank = 2
							}
						}
						if m.CompletedDays != wantDays || m.Left != wantLeft || m.Rank != wantRank || m.Self != ((d == a) == (m.Nickname == "Leaf")) {
							t.Fatalf("unexpected member: %+v", m)
						}
					}
				}
			}
			assertMembers(1, 0, false, "active")
			journeyEqual(t, list(a).Progress.Days[0].Milliseconds, 300000)
			setDay(10)
			report(b, "what-men-live-by", "2026-03-08", 1) // Late sync completes the first day.
			assertMembers(1, 1, false, "active")
			action(a, "leave", nil)
			frozen := list(a).Progress.Days
			report(a, "room-for-stories", "2026-03-09", 300000)
			action(a, "leave", nil) // Lost-response retry must retain the snapshot.
			assertMembers(1, 1, true, "active")
			setDay(15)
			assertMembers(1, 1, true, "ended")
			report(b, "what-men-live-by", "2026-03-09", bMinutes*60000)
			assertMembers(1, 2, true, "ended")
			journeyEqual(t, list(a).Progress.Days, frozen)
			for _, d := range []*journeyDevice{a, b} {
				raw, _ := json.Marshal(d.request("GET", "/challenges?accountId="+d.session.User.ID, nil, 200))
				other := a.session.User.ID
				if d == a {
					other = b.session.User.ID
				}
				for _, secret := range []string{other, "@example.test", "room-for-stories", "what-men-live-by"} {
					if strings.Contains(string(raw), secret) {
						t.Fatalf("private detail leaked: %s", secret)
					}
				}
			}
			journeyEqual(t, outsider.request("GET", "/challenges?accountId="+outsider.session.User.ID, nil, 200)["items"], []any{})
			outsider.request("GET", "/challenges?accountId="+a.session.User.ID, nil, 409)
		})
	}
}
