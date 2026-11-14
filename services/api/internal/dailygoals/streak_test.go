package dailygoals

import "testing"

func TestStreakCalendarAndHistory(t *testing.T) {
	goal := Goal{Changes: []Target{{From: "2026-12-28", Minutes: 20}, {From: "2026-12-31", Minutes: 5}}}
	totals := map[string]int64{"2026-12-29": 1200000, "2026-12-30": 1200000, "2026-12-31": 300000, "2027-01-01": 299999}
	check := func(day string, want int) {
		t.Helper()
		if got := Streak(goal, day, totals); got != want {
			t.Fatalf("%s: got %d want %d", day, got, want)
		}
	}
	check("2027-01-01", 3)
	totals["2027-01-01"] = 300000
	check("2027-01-01", 4)
	check("2026-12-30", 2)
	check("2027-01-03", 0)
	totals["2027-01-03"] = 300000
	check("2027-01-03", 1)
	totals["2027-01-02"] = 300000
	check("2027-01-03", 6)
	if got := Streak(goal, "2027-01-03", map[string]int64{}); got != 0 {
		t.Fatal(got)
	}
}
