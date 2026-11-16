package challenges

import "testing"

func TestCompetitionPlaces(t *testing.T) {
	for _, status := range []string{"active", "ended"} {
		members := []Member{{CompletedDays: 2}, {CompletedDays: 7}, {CompletedDays: 2, Left: true}, {CompletedDays: 0}, {CompletedDays: 7}}
		rankMembers("competitive", status, members)
		for i, want := range []int{3, 1, 3, 5, 1} {
			if members[i].Rank != want {
				t.Fatalf("%s member %d: %+v want rank %d", status, i, members[i], want)
			}
		}
	}
	for _, mode := range []string{"competitive", "personal"} {
		for _, status := range []string{"upcoming", "active", "ended"} {
			if mode == "competitive" && status != "upcoming" {
				continue
			}
			members := []Member{{Rank: 1, CompletedDays: 7}, {Rank: 2}}
			rankMembers(mode, status, members)
			for _, m := range members {
				if m.Rank != 0 {
					t.Fatalf("%s %s: %+v", mode, status, members)
				}
			}
		}
	}
	members := []Member{{}, {}}
	rankMembers("competitive", "ended", members)
	if members[0].Rank != 1 || members[1].Rank != 1 {
		t.Fatal(members)
	}
}
