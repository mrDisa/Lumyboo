package httpapi

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"lumyboo/services/api/internal/challenges"
	"lumyboo/services/api/internal/readingsessions"
)

func TestPostgresChallengeProgressMigration(t *testing.T) {
	pool := journeyDatabase(t)
	mailbox, device := journeyServer(t, pool)
	a := device()
	a.login("legacy-progress@example.test", mailbox)
	ctx := context.Background()
	now := time.Now().UTC()
	store := challenges.Postgres{Pool: pool, Now: func() time.Time { return now }}
	c, err := store.Create(ctx, a.session.User.ID, challenges.Create{OperationID: journeyID(t), Name: "Legacy", Nickname: "Reader", Mode: "personal", StartDay: now.AddDate(0, 0, 1).Format("2006-01-02"), Duration: 7, TimeZone: "UTC", Minutes: 5})
	if err != nil {
		t.Fatal(err)
	}
	day := now.AddDate(0, 0, -1).Format("2006-01-02")
	if _, err = pool.Exec(ctx, `UPDATE challenges SET start_day=$2::text::date WHERE id=$1`, c.ID, day); err != nil {
		t.Fatal(err)
	}
	sessions := readingsessions.Postgres{Pool: pool}
	change := readingsessions.Change{OperationID: journeyID(t), Session: readingsessions.Report{SessionID: journeyID(t), DeviceID: journeyID(t), BookID: "room-for-stories", Version: "1", Day: day, Milliseconds: 300000}}
	if _, err = sessions.Apply(ctx, a.session.User.ID, change); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `ALTER TABLE challenge_members DROP COLUMN days_at_exit; UPDATE challenge_members SET left_at=now()`); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../db/migrations/013_challenge_progress.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	change.OperationID = journeyID(t)
	change.Session.Milliseconds = 600000
	if _, err = sessions.Apply(ctx, a.session.User.ID, change); err != nil {
		t.Fatal(err)
	}
	items, err := store.List(ctx, a.session.User.ID)
	if err != nil || len(items) != 1 {
		t.Fatalf("%+v %v", items, err)
	}
	if !items[0].Left || items[0].Progress.Days[0].Milliseconds != 300000 || items[0].Members[0].CompletedDays != 1 {
		t.Fatalf("legacy departure changed: %+v", items[0])
	}
}

func TestPostgresChallengeProgress(t *testing.T) {
	for _, mode := range []string{"competitive", "personal"} {
		t.Run(mode, func(t *testing.T) {
			pool := journeyDatabase(t)
			mailbox, device := journeyServer(t, pool)
			a, b, outsider := device(), device(), device()
			a.login("progress-a@example.test", mailbox)
			b.login("progress-b@example.test", mailbox)
			outsider.login("progress-c@example.test", mailbox)
			ctx := context.Background()
			now := time.Date(2026, 3, 7, 12, 0, 0, 0, time.UTC)
			store := challenges.Postgres{Pool: pool, Now: func() time.Time { return now }}
			c, err := store.Create(ctx, a.session.User.ID, challenges.Create{OperationID: journeyID(t), Name: "Progress", Nickname: "Same", Mode: mode, StartDay: "2026-03-08", Duration: 7, TimeZone: "America/New_York", Minutes: 10})
			if err != nil {
				t.Fatal(err)
			}
			invite, err := store.Action(ctx, a.session.User.ID, challenges.Action{Kind: "invite", ChallengeID: c.ID})
			if err != nil {
				t.Fatal(err)
			}
			preview, err := store.Action(ctx, b.session.User.ID, challenges.Action{Kind: "preview", Code: invite.Code})
			if err != nil || len(preview.Challenge.Members) != 0 || len(preview.Challenge.Progress.Days) != 0 {
				t.Fatalf("preview leaked: %+v %v", preview, err)
			}
			joined, err := store.Action(ctx, b.session.User.ID, challenges.Action{Kind: "join", Code: invite.Code, Nickname: "Same", Minutes: 5})
			if err != nil {
				t.Fatal(err)
			}
			target := int64(600000)
			if mode == "personal" {
				target = 300000
			}
			if joined.Challenge.Progress.Status != "upcoming" {
				t.Fatal(joined)
			}
			sessions := readingsessions.Postgres{Pool: pool}
			report := func(owner, day string, ms int64) readingsessions.Change {
				change := readingsessions.Change{OperationID: journeyID(t), Session: readingsessions.Report{SessionID: journeyID(t), DeviceID: journeyID(t), BookID: "room-for-stories", Version: "1", Day: day, Milliseconds: ms}}
				if _, err := sessions.Apply(ctx, owner, change); err != nil {
					t.Fatal(err)
				}
				return change
			}
			report(a.session.User.ID, "2026-03-07", 600000) // Before start.
			first := report(a.session.User.ID, "2026-03-08", 599999)
			report(a.session.User.ID, "2026-03-08", 1) // Another device, same day.
			report(a.session.User.ID, "2026-03-09", 600000)
			report(a.session.User.ID, "2026-03-15", 600000) // Outside period.
			report(b.session.User.ID, "2026-03-08", target-1)
			report(b.session.User.ID, "2026-03-09", target)
			list := func(owner string) challenges.Challenge {
				t.Helper()
				items, err := store.List(ctx, owner)
				if err != nil || len(items) != 1 {
					t.Fatalf("%+v %v", items, err)
				}
				return items[0]
			}
			now = time.Date(2026, 3, 9, 3, 59, 0, 0, time.UTC) // Still March 8 in New York after DST.
			got := list(a.session.User.ID)
			if got.Progress.Today != "2026-03-08" || got.Progress.EndDay != "2026-03-14" || got.Progress.Days[0].Milliseconds != 600000 || !got.Progress.Days[0].Complete || got.Progress.Days[1].Complete {
				t.Fatalf("%+v", got)
			}
			if _, err := sessions.Apply(ctx, a.session.User.ID, first); err != nil {
				t.Fatal(err)
			} // Lost-response retry.
			first.OperationID = journeyID(t)
			first.Session.Milliseconds = 10
			if _, err := sessions.Apply(ctx, a.session.User.ID, first); err != nil {
				t.Fatal(err)
			} // Delayed smaller total.
			if list(a.session.User.ID).Progress.Days[0].Milliseconds != 600000 {
				t.Fatal("duplicate or smaller snapshot changed total")
			}
			now = time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
			report(b.session.User.ID, "2026-03-08", 1) // Late report completes historical day.
			for _, owner := range []string{a.session.User.ID, b.session.User.ID} {
				got = list(owner)
				self := 0
				for _, m := range got.Members {
					if m.CompletedDays != 2 {
						t.Fatal(m)
					}
					if m.Self {
						self++
					}
				}
				if self != 1 {
					t.Fatal("duplicate nicknames must not identify self")
				}
			}
			// Changing the ordinary daily goal never changes challenge targets.
			if _, err := pool.Exec(ctx, `INSERT INTO daily_goal_settings(user_id,time_zone,revision) VALUES($1,'UTC',1);`, a.session.User.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO daily_goal_changes(user_id,effective_from,minutes) VALUES($1,'2026-03-07',60)`, a.session.User.ID); err != nil {
				t.Fatal(err)
			}
			left, err := store.Action(ctx, a.session.User.ID, challenges.Action{Kind: "leave", ChallengeID: c.ID})
			if err != nil || !left.Challenge.Left {
				t.Fatalf("%+v %v", left, err)
			}
			frozen, _ := json.Marshal(left.Challenge.Progress.Days)
			report(a.session.User.ID, "2026-03-10", 600000)
			report(a.session.User.ID, "2026-03-09", 600000)
			report(b.session.User.ID, "2026-03-10", target)
			now = time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
			got = list(a.session.User.ID)
			actual, _ := json.Marshal(got.Progress.Days)
			if string(actual) != string(frozen) || got.Progress.Status != "ended" {
				t.Fatalf("exit snapshot changed: %+v", got)
			}
			for _, m := range got.Members {
				if m.Self && m.CompletedDays != 2 || !m.Self && m.CompletedDays != 3 {
					t.Fatal(m)
				}
			}
			again, err := store.Action(ctx, a.session.User.ID, challenges.Action{Kind: "leave", ChallengeID: c.ID})
			if err != nil {
				t.Fatal(err)
			}
			actual, _ = json.Marshal(again.Challenge.Progress.Days)
			if string(actual) != string(frozen) {
				t.Fatal("leave retry changed snapshot")
			}
			// The HTTP response exposes only own daily durations; no member IDs or books.
			raw, _ := json.Marshal(b.request("GET", "/challenges?accountId="+b.session.User.ID, nil, 200))
			for _, secret := range []string{a.session.User.ID, "room-for-stories", "progress-a@example.test"} {
				if strings.Contains(string(raw), secret) {
					t.Fatalf("leaked %s", secret)
				}
			}
			journeyEqual(t, outsider.request("GET", "/challenges?accountId="+outsider.session.User.ID, nil, 200)["items"], []any{})
			outsider.request("GET", "/challenges?accountId="+a.session.User.ID, nil, 409)
		})
	}
}
