package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

type stubStore struct {
	created              Challenge
	attempt              Attempt
	cancelled, delivered bool
	createErr            error
}

func (s *stubStore) Create(_ context.Context, c Challenge) error { s.created = c; return s.createErr }
func (s *stubStore) Delivered(context.Context, string, time.Time) error {
	s.delivered = true
	return nil
}
func (s *stubStore) Cancel(context.Context, string) error { s.cancelled = true; return nil }
func (s *stubStore) Consume(_ context.Context, a Attempt) (User, error) {
	s.attempt = a
	return User{ID: a.NewUserID, Email: "reader@example.test"}, nil
}
func (s *stubStore) Session(context.Context, []byte, time.Time) (User, error) {
	return User{}, ErrUnauthenticated
}
func (s *stubStore) Revoke(context.Context, string, []byte, bool, time.Time) error { return nil }

type captureMailer struct {
	email, code string
	fail        bool
	sent        int
}

func (m *captureMailer) SendCode(_ context.Context, email, code string, _ time.Duration) error {
	m.sent++
	m.email = email
	m.code = code
	if m.fail {
		return errors.New("delivery error with sensitive recipient")
	}
	return nil
}
func testService(t *testing.T, store Store, mailer Mailer) *Service {
	t.Helper()
	s, err := New(store, mailer, []byte(strings.Repeat("s", 32)))
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func TestRequestAndSessionSecrets(t *testing.T) {
	store := &stubStore{}
	mailer := &captureMailer{}
	s := testService(t, store, mailer)
	issued, err := s.Request(context.Background(), " Reader@Example.test ", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if mailer.email != "Reader@example.test" || len(mailer.code) != 6 || !store.delivered || len(store.created.CodeHash) != 32 {
		t.Fatal("invalid challenge or delivery")
	}
	if strings.Contains(string(store.created.CodeHash), mailer.code) {
		t.Fatal("raw code persisted")
	}
	login, err := s.Verify(context.Background(), issued.ChallengeID, mailer.code, "127.0.0.1", "")
	if err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(login)
	if err != nil || strings.Contains(string(wire), login.Token) {
		t.Fatal("session token is serializable")
	}
	if len(login.Token) != 43 || len(store.attempt.SessionHash) != 32 || string(store.attempt.SessionHash) == login.Token {
		t.Fatal("invalid session token storage")
	}
	if !s.ValidCSRF(login.Token, login.CSRFToken) || s.ValidCSRF("another-token", login.CSRFToken) {
		t.Fatal("CSRF is not session bound")
	}
}
func TestUndeliveredCodeCannotBeActivated(t *testing.T) {
	store := &stubStore{}
	s := testService(t, store, &captureMailer{fail: true})
	_, err := s.Request(context.Background(), "reader@example.test", "127.0.0.1")
	if !errors.Is(err, ErrDelivery) || !store.cancelled || store.delivered {
		t.Fatal("failed delivery was activated")
	}
}
func TestInvalidEmailAndRateLimitDoNotSendMail(t *testing.T) {
	store := &stubStore{}
	mailer := &captureMailer{}
	s := testService(t, store, mailer)
	for _, email := range []string{"not-email", "Name <a@example.test>", "a@example.test\r\nBcc: b@example.test"} {
		if _, err := s.Request(context.Background(), email, "ip"); !errors.Is(err, ErrEmail) {
			t.Fatal("invalid email accepted")
		}
	}
	store.createErr = &RateError{RetryAfter: 60}
	if _, err := s.Request(context.Background(), "a@example.test", "ip"); !errors.Is(err, ErrRateLimited) {
		t.Fatal(err)
	}
	if mailer.code != "" {
		t.Fatal("mail sent despite rejection")
	}
}
func TestAuthenticationConfiguration(t *testing.T) {
	base := map[string]string{"AUTH_SECRET": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))), "PUBLIC_ORIGIN": "http://127.0.0.1:5173", "APP_ENV": "development", "SMTP_ADDRESS": "127.0.0.1:1025", "SMTP_FROM": "login@lumyboo.local", "SMTP_ALLOW_INSECURE": "true"}
	if config, err := LoadConfig(func(key string) string { return base[key] }); err != nil || config.SecureCookies {
		t.Fatal("local development config rejected", err)
	}
	for _, change := range []map[string]string{{"PUBLIC_ORIGIN": "http://example.com"}, {"APP_ENV": "production"}, {"SMTP_ADDRESS": "smtp.example.com:587"}, {"PUBLIC_ORIGIN": "http://127.0.0.1:5173/path"}, {"AUTH_SECRET": "not-base64"}} {
		values := map[string]string{}
		for k, v := range base {
			values[k] = v
		}
		for k, v := range change {
			values[k] = v
		}
		if _, err := LoadConfig(func(k string) string { return values[k] }); err == nil {
			t.Fatal("unsafe auth config accepted")
		}
	}
	values := map[string]string{}
	for k, v := range base {
		values[k] = v
	}
	values["APP_ENV"] = "production"
	values["PUBLIC_ORIGIN"] = "https://lumyboo.example"
	values["SMTP_ALLOW_INSECURE"] = "false"
	values["SMTP_ADDRESS"] = "smtp.example.com:587"
	if config, err := LoadConfig(func(k string) string { return values[k] }); err != nil || !config.SecureCookies {
		t.Fatal("secure config rejected", err)
	}
}
