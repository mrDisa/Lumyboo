package challenges

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

type ProgressDay struct {
	Day          string `json:"day"`
	Milliseconds int64  `json:"milliseconds"`
	Complete     bool   `json:"complete"`
}
type Progress struct {
	Today  string        `json:"today"`
	EndDay string        `json:"endDay"`
	Status string        `json:"status"`
	Days   []ProgressDay `json:"days"`
}
type progressQuery interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func (s Postgres) progress(ctx context.Context, q progressQuery, owner string, c *Challenge) error {
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	zone, err := time.LoadLocation(c.TimeZone)
	if err != nil {
		return err
	}
	today := now.In(zone).Format("2006-01-02")
	start, _ := time.Parse("2006-01-02", c.StartDay)
	end := start.AddDate(0, 0, c.Duration-1).Format("2006-01-02")
	status := "active"
	if today < c.StartDay {
		status = "upcoming"
	} else if today > end {
		status = "ended"
	}
	c.Progress = Progress{Today: today, EndDay: end, Status: status, Days: []ProgressDay{}}
	// Session dates are retained by product decision: historical reports have no
	// timestamps for time zone conversion. The challenge zone bounds the current
	// day and period. Only the requester receives daily durations.
	rows, err := q.Query(ctx, `SELECT p.nickname,p.minutes,p.left_at IS NOT NULL,p.user_id=$2,p.days_at_exit,
 COALESCE((SELECT json_object_agg(t.day,t.ms) FROM (
 SELECT to_char(r.reported_day,'YYYY-MM-DD') AS day,sum(r.milliseconds)::bigint AS ms
 FROM reading_sessions r WHERE r.user_id=p.user_id AND r.reported_day >= $3::text::date
 AND r.reported_day <= LEAST($4::text::date,$5::text::date,COALESCE((p.left_at AT TIME ZONE $6)::date,$4::text::date))
 GROUP BY r.reported_day) t),'{}'::json)
 FROM challenge_members p WHERE p.challenge_id=$1 ORDER BY p.joined_at,p.user_id`, c.ID, owner, c.StartDay, end, today, c.TimeZone)
	if err != nil {
		return err
	}
	defer rows.Close()
	members := []Member{}
	for rows.Next() {
		var m Member
		var frozen, raw []byte
		if err := rows.Scan(&m.Nickname, &m.Minutes, &m.Left, &m.Self, &frozen, &raw); err != nil {
			return err
		}
		totals := map[string]int64{}
		if err := json.Unmarshal(raw, &totals); err != nil {
			return err
		}
		days := make([]ProgressDay, 0, c.Duration)
		for i := 0; i < c.Duration; i++ {
			day := start.AddDate(0, 0, i).Format("2006-01-02")
			ms := totals[day]
			days = append(days, ProgressDay{Day: day, Milliseconds: ms, Complete: ms >= int64(m.Minutes)*60000})
		}
		if m.Left && len(frozen) > 0 {
			if err := json.Unmarshal(frozen, &days); err != nil {
				return err
			}
		}
		for _, day := range days {
			if day.Complete {
				m.CompletedDays++
			}
			if day.Day == today && day.Complete {
				m.TodayComplete = true
			}
		}
		if m.Self {
			c.Progress.Days = days
		}
		members = append(members, m)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rankMembers(c.Mode, status, members)
	c.Members = members
	return nil
}

// Competition ranking: equal completed-day counts share a place (1, 1, 3).
// Departures retain their saved results; extra minutes never break a tie.
func rankMembers(mode, status string, members []Member) {
	for i := range members {
		members[i].Rank = 0
		if mode != "competitive" || status == "upcoming" {
			continue
		}
		members[i].Rank = 1
		for j := range members {
			if members[j].CompletedDays > members[i].CompletedDays {
				members[i].Rank++
			}
		}
	}
}
