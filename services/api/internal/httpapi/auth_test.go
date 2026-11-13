package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"lumyboo/services/api/internal/auth"
)

type httpStore struct{}

func (httpStore) Create(context.Context, auth.Challenge) error       { return nil }
func (httpStore) Delivered(context.Context, string, time.Time) error { return nil }
func (httpStore) Cancel(context.Context, string) error               { return nil }
func (httpStore) Consume(context.Context, auth.Attempt) (auth.User, error) {
	return auth.User{ID: "00000000-0000-4000-8000-000000000001", Email: "reader@example.test"}, nil
}
func (httpStore) Session(context.Context, []byte, time.Time) (auth.User, error) {
	return auth.User{ID: "00000000-0000-4000-8000-000000000001", Email: "reader@example.test"}, nil
}
func (httpStore) Revoke(context.Context, string, []byte, bool, time.Time) error { return nil }

type httpMailer struct{ fail bool }

func (m httpMailer) SendCode(context.Context, string, string, time.Duration) error {
	if m.fail {
		return errors.New("private SMTP error")
	}
	return nil
}
func authServer(t *testing.T, secure bool) http.Handler {
	t.Helper()
	service, err := auth.New(httpStore{}, httpMailer{}, []byte(strings.Repeat("s", 32)))
	if err != nil {
		t.Fatal(err)
	}
	return New(nil, AuthOptions{Service: service, Origin: "https://lumyboo.example", SecureCookies: secure})
}
func authRequest(handler http.Handler, method, path, body, origin, cookie, csrf string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}
func TestAuthOriginAndBodyValidation(t *testing.T) {
	server := authServer(t, true)
	for _, test := range []struct {
		origin, body string
		status       int
	}{{"", `{"email":"r@example.test"}`, 403}, {"https://evil.example", `{"email":"r@example.test"}`, 403}, {"https://lumyboo.example", `{"email":"r@example.test","extra":true}`, 400}, {"https://lumyboo.example", `{"email":"r@example.test"} {}`, 400}, {"https://lumyboo.example", `{"email":"` + strings.Repeat("a", 2200) + `"}`, 400}} {
		w := authRequest(server, "POST", "/api/v1/auth/code", test.body, test.origin, "", "")
		if w.Code != test.status {
			t.Fatalf("got %d expected %d", w.Code, test.status)
		}
	}
}
func TestAuthCookieAndCSRFSecurity(t *testing.T) {
	server := authServer(t, true)
	w := authRequest(server, "POST", "/api/v1/auth/verify", `{"challengeId":"`+strings.Repeat("a", 43)+`","code":"123456"}`, "https://lumyboo.example", "", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing session cookie")
	}
	cookie := cookies[0]
	if !cookie.Secure || !cookie.HttpOnly || cookie.Path != "/" || cookie.Domain != "" || cookie.Name != "__Host-lumyboo_session" || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatal("unsafe session cookie")
	}
	if strings.Contains(w.Body.String(), cookie.Value) {
		t.Fatal("raw token leaked into JSON")
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private response cacheable")
	}
	var session sessionView
	if err := json.Unmarshal(w.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	header := cookie.Name + "=" + cookie.Value
	if denied := authRequest(server, "POST", "/api/v1/auth/logout", "", "https://lumyboo.example", header, ""); denied.Code != 403 {
		t.Fatal("logout without CSRF accepted")
	}
	if denied := authRequest(server, "POST", "/api/v1/auth/logout", "", "https://evil.example", header, session.CSRFToken); denied.Code != 403 {
		t.Fatal("cross-site logout accepted")
	}
	if ok := authRequest(server, "POST", "/api/v1/auth/logout", "", "https://lumyboo.example", header, session.CSRFToken); ok.Code != 204 || ok.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout did not clear cookie")
	}
}
func TestAuthDisabledAndGuestSession(t *testing.T) {
	if w := authRequest(New(nil), "GET", "/api/v1/auth/session", "", "", "", ""); w.Code != 503 {
		t.Fatal("unconfigured authentication should be unavailable")
	}
	if w := authRequest(authServer(t, false), "GET", "/api/v1/auth/session", "", "", "", ""); w.Code != 401 {
		t.Fatal("guest must not be authenticated")
	}
}

func TestClientIPTrustsOnlyConfiguredProxies(t *testing.T) {
	prefix := netip.MustParsePrefix("127.0.0.1/32")
	for _, test := range []struct {
		remote, forwarded, expected string
		trusted                     bool
	}{
		{"203.0.113.1:1234", "198.51.100.1", "203.0.113.1", false},
		{"127.0.0.1:1234", "198.51.100.1", "127.0.0.1", false},
		{"127.0.0.1:1234", "198.51.100.1", "198.51.100.1", true},
		{"127.0.0.1:1234", "198.51.100.99, 203.0.113.1", "203.0.113.1", true},
		{"127.0.0.1:1234", "198.51.100.1, 127.0.0.1", "198.51.100.1", true},
		{"127.0.0.1:1234", "invalid", "127.0.0.1", true},
	} {
		h := authHandler{}
		if test.trusted {
			h.TrustedProxies = []netip.Prefix{prefix}
		}
		req := httptest.NewRequest("POST", "/", nil)
		req.RemoteAddr = test.remote
		req.Header.Set("X-Forwarded-For", test.forwarded)
		if got := h.clientIP(req); got != test.expected {
			t.Fatalf("got IP %s, expected %s", got, test.expected)
		}
	}
}
