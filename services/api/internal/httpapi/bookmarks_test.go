package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"lumyboo/services/api/internal/auth"
	"lumyboo/services/api/internal/bookmarks"
)

type bookmarkMemory struct {
	owner   string
	entries []bookmarks.Entry
	calls   int
}

func (s *bookmarkMemory) List(_ context.Context, owner string) ([]bookmarks.Entry, error) {
	s.owner = owner
	return s.entries, nil
}
func (s *bookmarkMemory) Import(_ context.Context, owner string, entries []bookmarks.Entry) ([]bookmarks.Entry, error) {
	s.owner = owner
	s.entries = entries
	s.calls++
	return entries, nil
}
func bookmarkServer(t *testing.T, store bookmarks.Store) (http.Handler, string, sessionView) {
	t.Helper()
	service, err := auth.New(httpStore{}, httpMailer{}, []byte(strings.Repeat("s", 32)))
	if err != nil {
		t.Fatal(err)
	}
	handler := New(nil, AuthOptions{Service: service, Bookmarks: store, Origin: "https://lumyboo.example"})
	login := authRequest(handler, "POST", "/api/v1/auth/verify", `{"challengeId":"`+strings.Repeat("a", 43)+`","code":"123456"}`, "https://lumyboo.example", "", "")
	if login.Code != 200 {
		t.Fatal(login.Code, login.Body)
	}
	cookie := login.Result().Cookies()[0]
	var session sessionView
	if err = json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	return handler, cookie.Name + "=" + cookie.Value, session
}
func sampleBookmark(t *testing.T) bookmarks.Entry {
	t.Helper()
	var locations map[string]editionLocations
	if err := json.Unmarshal(bookmarkLocations, &locations); err != nil {
		t.Fatal(err)
	}
	return bookmarks.Entry{BookID: "room-for-stories", Version: "1", Chapter: 0, Paragraph: locations["room-for-stories"].Chapters[0][0], Offset: .4, Label: "Первая глава"}
}
func TestBookmarkImportSecurityAndValidation(t *testing.T) {
	store := &bookmarkMemory{entries: []bookmarks.Entry{}}
	handler, cookie, session := bookmarkServer(t, store)
	entry := sampleBookmark(t)
	makeBody := func(entries []bookmarks.Entry) string {
		raw, _ := json.Marshal(map[string]any{"accountId": session.User.ID, "bookmarks": entries})
		return string(raw)
	}
	body := makeBody([]bookmarks.Entry{entry})
	for _, tc := range []struct {
		name, body, cookie, csrf, origin string
		status                           int
	}{
		{"guest", body, "", "", "https://lumyboo.example", 401},
		{"csrf", body, cookie, "", "https://lumyboo.example", 403},
		{"origin", body, cookie, session.CSRFToken, "https://evil.example", 403},
		{"owner changed", strings.Replace(body, session.User.ID, "other-account", 1), cookie, session.CSRFToken, "https://lumyboo.example", 409},
		{"empty", makeBody(nil), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"missing offset", strings.Replace(body, `"offset":0.4,`, "", 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"unknown field", strings.Replace(body, `"offset":0.4`, `"offset":0.4,"owner":"other"`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := authRequest(handler, "POST", "/api/v1/bookmarks/import", tc.body, tc.origin, tc.cookie, tc.csrf)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body)
			}
		})
	}
	for _, mutate := range []func(*bookmarks.Entry){
		func(e *bookmarks.Entry) { e.Version = "old" }, func(e *bookmarks.Entry) { e.Chapter = 99 }, func(e *bookmarks.Entry) { e.Paragraph = "missing" }, func(e *bookmarks.Entry) { e.Offset = 1 }, func(e *bookmarks.Entry) { e.Offset = -.1 }, func(e *bookmarks.Entry) { e.Label = strings.Repeat("я", 201) },
	} {
		invalid := entry
		mutate(&invalid)
		w := authRequest(handler, "POST", "/api/v1/bookmarks/import", makeBody([]bookmarks.Entry{entry, invalid}), "https://lumyboo.example", cookie, session.CSRFToken)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
	if store.calls != 0 {
		t.Fatal("invalid batch reached storage")
	}
	w := authRequest(handler, "POST", "/api/v1/bookmarks/import", body, "https://lumyboo.example", cookie, session.CSRFToken)
	if w.Code != 200 || store.owner != session.User.ID || len(store.entries) != 1 || store.entries[0] != entry {
		t.Fatal(w.Code, w.Body, store)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private response cacheable")
	}
	w = authRequest(handler, "GET", "/api/v1/bookmarks/", "", "", cookie, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	w = authRequest(handler, "GET", "/api/v1/bookmarks/", "", "", "", "")
	if w.Code != 401 {
		t.Fatal("guest sees bookmarks")
	}
}

func (s *bookmarkMemory) State(_ context.Context, owner string) ([]bookmarks.State, error) {
	s.owner = owner
	return []bookmarks.State{{Entry: s.entries[0], Revision: 2, Deleted: true}}, nil
}
func (s *bookmarkMemory) Apply(_ context.Context, owner string, change bookmarks.Change) (bookmarks.State, error) {
	s.owner = owner
	s.calls++
	switch change.ExpectedRevision {
	case 7:
		return bookmarks.State{}, bookmarks.ErrConflict
	case 8:
		return bookmarks.State{}, bookmarks.ErrOperationReused
	case 9:
		return bookmarks.State{}, context.DeadlineExceeded
	}
	return bookmarks.State{Entry: change.Bookmark, Revision: change.ExpectedRevision + 1, Deleted: change.Deleted}, nil
}
func TestBookmarkApplySecurityAndValidation(t *testing.T) {
	entry := sampleBookmark(t)
	store := &bookmarkMemory{entries: []bookmarks.Entry{entry}}
	handler, cookie, session := bookmarkServer(t, store)
	change := bookmarks.Change{OperationID: "11111111-1111-4111-8111-111111111111", Bookmark: entry, Deleted: true}
	encode := func(c bookmarks.Change) string {
		raw, _ := json.Marshal(struct {
			AccountID string `json:"accountId"`
			bookmarks.Change
		}{session.User.ID, c})
		return string(raw)
	}
	body := encode(change)
	for _, tc := range []struct {
		name, body, cookie, csrf, origin string
		status                           int
	}{
		{"guest", body, "", "", "https://lumyboo.example", 401},
		{"csrf", body, cookie, "", "https://lumyboo.example", 403},
		{"origin", body, cookie, session.CSRFToken, "https://evil.example", 403},
		{"owner", strings.Replace(body, session.User.ID, "other", 1), cookie, session.CSRFToken, "https://lumyboo.example", 409},
		{"missing revision", strings.Replace(body, `"expectedRevision":0,`, "", 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"missing deleted", strings.Replace(body, `,"deleted":true`, "", 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"missing label", strings.Replace(body, `,"label":"Первая глава"`, "", 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"unknown field", strings.Replace(body, `"deleted":true`, `"deleted":true,"owner":"other"`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := authRequest(handler, "POST", "/api/v1/bookmarks/apply", tc.body, tc.origin, tc.cookie, tc.csrf)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body)
			}
		})
	}
	for _, revision := range []int64{-1, 9007199254740991} {
		invalid := change
		invalid.ExpectedRevision = revision
		w := authRequest(handler, "POST", "/api/v1/bookmarks/apply", encode(invalid), "https://lumyboo.example", cookie, session.CSRFToken)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
	for _, mutate := range []func(*bookmarks.Change){
		func(c *bookmarks.Change) { c.OperationID = "bad" },
		func(c *bookmarks.Change) { c.Bookmark.Version = "old" },
		func(c *bookmarks.Change) { c.Bookmark.Paragraph = "unknown" },
		func(c *bookmarks.Change) { c.Bookmark.Chapter = -1 },
		func(c *bookmarks.Change) { c.Bookmark.Offset = 1 },
		func(c *bookmarks.Change) { c.Bookmark.Label = strings.Repeat("я", 201) },
	} {
		invalid := change
		mutate(&invalid)
		w := authRequest(handler, "POST", "/api/v1/bookmarks/apply", encode(invalid), "https://lumyboo.example", cookie, session.CSRFToken)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
	if store.calls != 0 {
		t.Fatal("invalid change reached storage")
	}
	for revision, status := range map[int64]int{0: 200, 7: 409, 8: 409, 9: 503} {
		next := change
		next.ExpectedRevision = revision
		w := authRequest(handler, "POST", "/api/v1/bookmarks/apply", encode(next), "https://lumyboo.example", cookie, session.CSRFToken)
		if w.Code != status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Code, w.Body)
		}
		if status == 200 {
			var result struct {
				AccountID string          `json:"accountId"`
				Bookmark  bookmarks.State `json:"bookmark"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.AccountID != session.User.ID || !result.Bookmark.Deleted || result.Bookmark.Revision != 1 || result.Bookmark.Entry != entry {
				t.Fatal(result, err)
			}
		}
	}
	w := authRequest(handler, "GET", "/api/v1/bookmarks/state", "", "", cookie, "")
	if w.Code != 200 || store.owner != session.User.ID || !strings.Contains(w.Body.String(), `"deleted":true`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body)
	}
	w = authRequest(handler, "GET", "/api/v1/bookmarks/state", "", "", "", "")
	if w.Code != 401 {
		t.Fatal("guest sees tombstones", w.Code)
	}
}
