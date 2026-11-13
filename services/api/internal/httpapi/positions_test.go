package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"lumyboo/services/api/internal/auth"
	"lumyboo/services/api/internal/positions"
)

type positionMemory struct {
	owner  string
	choice positions.Choice
	calls  int
	err    error
}

func (s *positionMemory) List(_ context.Context, owner string) ([]positions.Position, error) {
	s.owner = owner
	return []positions.Position{}, nil
}
func (s *positionMemory) Choose(_ context.Context, owner string, choice positions.Choice) (positions.Position, error) {
	s.owner = owner
	s.choice = choice
	s.calls++
	return positions.Position{Locator: choice.Position, Revision: 1}, s.err
}
func positionServer(t *testing.T, store positions.Store) (http.Handler, string, sessionView) {
	t.Helper()
	service, err := auth.New(httpStore{}, httpMailer{}, []byte(strings.Repeat("s", 32)))
	if err != nil {
		t.Fatal(err)
	}
	handler := New(nil, AuthOptions{Service: service, Positions: store, Origin: "https://lumyboo.example"})
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
func TestPositionChoiceSecurityAndConflicts(t *testing.T) {
	store := &positionMemory{}
	handler, cookie, session := positionServer(t, store)
	body := `{"accountId":"` + session.User.ID + `","operationId":"00000000-0000-4000-8000-000000000003","expectedRevision":0,"position":{"bookId":"room-for-stories","version":"1","chapter":0,"paragraph":"ch-1-p-1","offset":0.4}}`
	for _, tc := range []struct {
		name, body, cookie, csrf, origin string
		status                           int
	}{
		{"guest", body, "", "", "https://lumyboo.example", 401},
		{"csrf", body, cookie, "", "https://lumyboo.example", 403},
		{"origin", body, cookie, session.CSRFToken, "https://evil.example", 403},
		{"changed account", strings.Replace(body, session.User.ID, "other", 1), cookie, session.CSRFToken, "https://lumyboo.example", 409},
		{"missing revision", strings.Replace(body, `"expectedRevision":0,`, "", 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"missing offset", strings.Replace(body, `,"offset":0.4`, "", 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"unknown field", strings.Replace(body, `"offset":0.4`, `"offset":0.4,"updatedAt":"device-clock"`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"old edition", strings.Replace(body, `"version":"1"`, `"version":"old"`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"wrong chapter", strings.Replace(body, `"chapter":0`, `"chapter":1`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"negative offset", strings.Replace(body, `"offset":0.4`, `"offset":-1`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"unsafe revision", strings.Replace(body, `"expectedRevision":0`, `"expectedRevision":9007199254740991`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := authRequest(handler, "POST", "/api/v1/positions/choose", tc.body, tc.origin, tc.cookie, tc.csrf)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body)
			}
		})
	}
	if store.calls != 0 {
		t.Fatal("invalid request reached storage")
	}
	w := authRequest(handler, "POST", "/api/v1/positions/choose", body, "https://lumyboo.example", cookie, session.CSRFToken)
	if w.Code != 200 || store.owner != session.User.ID || store.choice.ExpectedRevision != 0 || store.choice.Position.Offset != .4 {
		t.Fatal(w.Code, w.Body, store)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private response cached")
	}
	for _, err := range []error{positions.ErrConflict, positions.ErrOperationReused} {
		store.err = err
		w = authRequest(handler, "POST", "/api/v1/positions/choose", body, "https://lumyboo.example", cookie, session.CSRFToken)
		if w.Code != 409 {
			t.Fatal(w.Code, w.Body)
		}
	}
	w = authRequest(handler, "GET", "/api/v1/positions/", "", "", cookie, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	w = authRequest(handler, "GET", "/api/v1/positions/", "", "", "", "")
	if w.Code != 401 {
		t.Fatal("guest sees positions")
	}
}
