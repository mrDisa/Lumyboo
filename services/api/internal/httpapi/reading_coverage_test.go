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
	"lumyboo/services/api/internal/readingcoverage"
)

type coverageMemory struct {
	owner, book, version, cursor string
	limit, calls                 int
	change                       readingcoverage.Change
	err                          error
}

func (s *coverageMemory) Apply(_ context.Context, owner string, change readingcoverage.Change) (readingcoverage.Coverage, error) {
	s.owner, s.change = owner, change
	s.calls++
	return change.Coverage, s.err
}
func (s *coverageMemory) List(_ context.Context, owner, book, version, cursor string, limit int) (readingcoverage.Page, error) {
	s.owner, s.book, s.version, s.cursor, s.limit = owner, book, version, cursor, limit
	s.calls++
	return readingcoverage.Page{Items: []readingcoverage.Coverage{}}, s.err
}
func coverageServer(t *testing.T, store readingcoverage.Store) (http.Handler, string, sessionView) {
	t.Helper()
	service, err := auth.New(httpStore{}, httpMailer{}, []byte(strings.Repeat("s", 32)))
	if err != nil {
		t.Fatal(err)
	}
	handler := New(nil, AuthOptions{Service: service, ReadingCoverage: store, Origin: "https://lumyboo.example"})
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
func TestCoverageSecurityAndValidation(t *testing.T) {
	store := &coverageMemory{}
	handler, cookie, session := coverageServer(t, store)
	body := `{"accountId":"` + session.User.ID + `","operationId":"00000000-0000-4000-8000-000000000003","coverage":{"bookId":"room-for-stories","version":"1","paragraph":"ch-1-p-1","ranges":[[0,200000],[800000,1000000]]}}`
	path := "/api/v1/reading-coverage/apply"
	for _, tc := range []struct {
		name, body, cookie, csrf, origin string
		status                           int
	}{
		{"guest", body, "", "", "https://lumyboo.example", 401},
		{"csrf", body, cookie, "", "https://lumyboo.example", 403},
		{"origin", body, cookie, session.CSRFToken, "https://evil.example", 403},
		{"missing origin", body, cookie, session.CSRFToken, "", 403},
		{"changed owner", strings.Replace(body, session.User.ID, "other", 1), cookie, session.CSRFToken, "https://lumyboo.example", 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := authRequest(handler, "POST", path, tc.body, tc.origin, tc.cookie, tc.csrf)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body)
			}
		})
	}
	for name, invalid := range map[string]string{
		"unknown paragraph": strings.Replace(body, "ch-1-p-1", "ch-99-p-1", 1),
		"unknown book":      strings.Replace(body, "room-for-stories", "unknown", 1),
		"old edition":       strings.Replace(body, `"version":"1"`, `"version":"old"`, 1),
		"unknown field":     strings.Replace(body, `"ranges":`, `"xp":500,"ranges":`, 1),
		"missing ranges":    strings.Replace(body, `,"ranges":[[0,200000],[800000,1000000]]`, "", 1),
		"short range":       strings.Replace(body, `[0,200000]`, `[0]`, 1),
		"long range":        strings.Replace(body, `[0,200000]`, `[0,200000,300000]`, 1),
		"null endpoint":     strings.Replace(body, `[0,200000]`, `[null,200000]`, 1),
		"fraction":          strings.Replace(body, `[0,200000]`, `[0,0.2]`, 1),
		"outside text":      strings.Replace(body, `[0,200000]`, `[-1,200000]`, 1),
		"reversed":          strings.Replace(body, `[0,200000]`, `[200000,0]`, 1),
		"invalid ID":        strings.Replace(body, "00000000-0000-4000-8000-000000000003", "bad", 1),
		"trailing object":   body + ` {}`,
		"oversized":         strings.Repeat(" ", 8192) + body,
	} {
		t.Run(name, func(t *testing.T) {
			w := authRequest(handler, "POST", path, invalid, "https://lumyboo.example", cookie, session.CSRFToken)
			if w.Code != 400 {
				t.Fatal(w.Code, w.Body)
			}
		})
	}
	for _, method := range []string{"GET", "POST"} {
		target := path
		if method == "GET" {
			target = "/api/v1/reading-coverage/room-for-stories?version=1"
		}
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		req.Header.Set("Cookie", cookie)
		req.Header.Set("Origin", "https://lumyboo.example")
		req.Header.Set("X-CSRF-Token", session.CSRFToken)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatal(w.Code, w.Body)
		}
	}
	if store.calls != 0 {
		t.Fatal("invalid requests reached storage", store.calls)
	}
	w := authRequest(handler, "POST", path, body, "https://lumyboo.example", cookie, session.CSRFToken)
	if w.Code != 200 || store.owner != session.User.ID || len(store.change.Coverage.Ranges) != 2 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body, store)
	}
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{readingcoverage.ErrInvalid, 400, "invalid_request"},
		{readingcoverage.ErrOperationReused, 409, "operation_reused"},
		{readingcoverage.ErrFragmentLimit, 409, "coverage_fragment_limit"},
		{errors.New("private database error"), 503, "reading_coverage_unavailable"},
	} {
		store.err = tc.err
		w := authRequest(handler, "POST", path, body, "https://lumyboo.example", cookie, session.CSRFToken)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) || strings.Contains(w.Body.String(), "private database") {
			t.Fatal(w.Code, w.Body)
		}
	}
}
func TestCoveragePrivatePages(t *testing.T) {
	store := &coverageMemory{}
	handler, cookie, session := coverageServer(t, store)
	path := "/api/v1/reading-coverage/room-for-stories"
	for _, query := range []string{"", "?version=1&limit=0", "?version=1&limit=51", "?version=1&limit=no", "?version=1&cursor=" + strings.Repeat("a", 201)} {
		w := authRequest(handler, "GET", path+query, "", "", cookie, "")
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
	w := authRequest(handler, "GET", path+"?version=1", "", "", "", "")
	if w.Code != 401 || store.calls != 0 {
		t.Fatal(w.Code, store.calls)
	}
	w = authRequest(handler, "GET", path+"?version=old&cursor=ch-1-p-1&limit=2", "", "", cookie, "")
	if w.Code != 200 || store.owner != session.User.ID || store.book != "room-for-stories" || store.version != "old" || store.cursor != "ch-1-p-1" || store.limit != 2 || !strings.Contains(w.Body.String(), `"items":[]`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body, store)
	}
	store.err = errors.New("private database error")
	w = authRequest(handler, "GET", path+"?version=1", "", "", cookie, "")
	if w.Code != 503 || strings.Contains(w.Body.String(), "private database") {
		t.Fatal(w.Code, w.Body)
	}
	unavailable, cookie, _ := coverageServer(t, nil)
	w = authRequest(unavailable, "GET", path+"?version=1", "", "", cookie, "")
	if w.Code != 503 {
		t.Fatal(w.Code, w.Body)
	}
}
