package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"lumyboo/services/api/internal/auth"
	"lumyboo/services/api/internal/readingsessions"
)

type readingSessionMemory struct {
	owner, id string
	change    readingsessions.Change
	calls     int
	err       error
}

func (s *readingSessionMemory) Get(_ context.Context, owner, id string) (readingsessions.Session, error) {
	s.owner = owner
	s.id = id
	s.calls++
	return readingsessions.Session{Report: s.change.Session, Revision: 1}, s.err
}
func (s *readingSessionMemory) Apply(_ context.Context, owner string, change readingsessions.Change) (readingsessions.Session, error) {
	s.owner = owner
	s.change = change
	s.calls++
	return readingsessions.Session{Report: change.Session, Revision: 1}, s.err
}
func readingSessionServer(t *testing.T, store readingsessions.Store) (http.Handler, string, sessionView) {
	t.Helper()
	service, err := auth.New(httpStore{}, httpMailer{}, []byte(strings.Repeat("s", 32)))
	if err != nil {
		t.Fatal(err)
	}
	handler := New(nil, AuthOptions{Service: service, ReadingSessions: store, Origin: "https://lumyboo.example"})
	login := authRequest(handler, "POST", "/api/v1/auth/verify", `{"challengeId":"`+strings.Repeat("a", 43)+`","code":"123456"}`, "https://lumyboo.example", "", "")
	if login.Code != 200 {
		t.Fatal(login.Code, login.Body)
	}
	var session sessionView
	if err := json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	cookie := login.Result().Cookies()[0]
	return handler, cookie.Name + "=" + cookie.Value, session
}
func TestReadingSessionSecurityValidationAndErrors(t *testing.T) {
	store := &readingSessionMemory{}
	handler, cookie, session := readingSessionServer(t, store)
	body := `{"accountId":"` + session.User.ID + `","operationId":"00000000-0000-4000-8000-000000000003","session":{"sessionId":"00000000-0000-4000-8000-000000000004","deviceId":"00000000-0000-4000-8000-000000000005","bookId":"room-for-stories","version":"1","day":"2026-11-13","milliseconds":1234}}`
	for _, tc := range []struct {
		name, body, cookie, csrf, origin string
		status                           int
	}{
		{"guest", body, "", "", "https://lumyboo.example", 401},
		{"csrf", body, cookie, "", "https://lumyboo.example", 403},
		{"origin", body, cookie, session.CSRFToken, "https://evil.example", 403},
		{"missing origin", body, cookie, session.CSRFToken, "", 403},
		{"changed owner", strings.Replace(body, session.User.ID, "other", 1), cookie, session.CSRFToken, "https://lumyboo.example", 409},
		{"missing ID", strings.Replace(body, `"sessionId":"00000000-0000-4000-8000-000000000004",`, "", 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"missing device", strings.Replace(body, `"deviceId":"00000000-0000-4000-8000-000000000005",`, "", 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"missing duration", strings.Replace(body, `,"milliseconds":1234`, "", 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"zero", strings.Replace(body, `:1234`, `:0`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"negative", strings.Replace(body, `:1234`, `:-1`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"fraction", strings.Replace(body, `:1234`, `:1.2`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"too long", strings.Replace(body, `:1234`, `:86400001`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"invalid day", strings.Replace(body, `2026-11-13`, `2026-02-29`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"unknown book", strings.Replace(body, `room-for-stories`, `unknown`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"old edition", strings.Replace(body, `"version":"1"`, `"version":"old"`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"unknown field", strings.Replace(body, `"milliseconds":1234`, `"milliseconds":1234,"xp":500`, 1), cookie, session.CSRFToken, "https://lumyboo.example", 400},
		{"trailing body", body + ` {}`, cookie, session.CSRFToken, "https://lumyboo.example", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := authRequest(handler, "POST", "/api/v1/reading-sessions/apply", tc.body, tc.origin, tc.cookie, tc.csrf)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body)
			}
		})
	}
	for _, method := range []string{"GET", "POST"} {
		path := "/api/v1/reading-sessions/apply"
		if method == "GET" {
			path = "/api/v1/reading-sessions/00000000-0000-4000-8000-000000000004"
		}
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Cookie", cookie)
		req.Header.Set("Origin", "https://lumyboo.example")
		req.Header.Set("X-CSRF-Token", session.CSRFToken)
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatal(w.Code, w.Body)
		}
	}
	if store.calls != 0 {
		t.Fatal("invalid request reached storage")
	}
	w := authRequest(handler, "POST", "/api/v1/reading-sessions/apply", body, "https://lumyboo.example", cookie, session.CSRFToken)
	if w.Code != 200 || store.owner != session.User.ID || store.change.Session.Milliseconds != 1234 || store.change.Session.Day != "2026-11-13" {
		t.Fatal(w.Code, w.Body, store)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private response cached")
	}
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{readingsessions.ErrOperationReused, 409, "operation_reused"}, {readingsessions.ErrSessionReused, 409, "reading_session_conflict"}, {readingsessions.ErrInvalid, 400, "invalid_request"}, {errors.New("private database error"), 503, "reading_sessions_unavailable"},
	} {
		store.err = tc.err
		w = authRequest(handler, "POST", "/api/v1/reading-sessions/apply", body, "https://lumyboo.example", cookie, session.CSRFToken)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) || strings.Contains(w.Body.String(), "private database") {
			t.Fatal(w.Code, w.Body)
		}
	}
	store.err = nil
	path := "/api/v1/reading-sessions/00000000-0000-4000-8000-000000000004"
	w = authRequest(handler, "GET", path, "", "", cookie, "")
	if w.Code != 200 || store.id != store.change.Session.SessionID || store.owner != session.User.ID || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body)
	}
	for _, tc := range []struct {
		path, cookie string
		err          error
		status       int
	}{
		{path, "", nil, 401}, {"/api/v1/reading-sessions/bad", cookie, nil, 400}, {path, cookie, readingsessions.ErrNotFound, 404}, {path, cookie, errors.New("private database error"), 503},
	} {
		store.err = tc.err
		w = authRequest(handler, "GET", tc.path, "", "", tc.cookie, "")
		if w.Code != tc.status {
			t.Fatal(w.Code, w.Body)
		}
	}
	for _, method := range []string{"GET", "POST"} {
		w = authRequest(New(nil), method, path, "", "", cookie, "")
		if w.Code != 503 {
			t.Fatal("unconfigured", w.Code, w.Body)
		}
	}
}
