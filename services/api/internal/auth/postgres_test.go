package auth

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func postgresService(t *testing.T) (*Service, *captureMailer, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL integration")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	mailer := &captureMailer{}
	return testService(t, NewPostgres(pool), mailer), mailer, pool
}
func address(t *testing.T) string {
	t.Helper()
	id, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	return strings.ToLower(id) + "@example.test"
}
func TestPostgresOTPIsSingleUseAndSessionsAreRevocable(t *testing.T) {
	s, mailer, pool := postgresService(t)
	ctx := context.Background()
	email := address(t)
	issued, err := s.Request(ctx, email, "ip-"+email)
	if err != nil {
		t.Fatal(err)
	}
	login, err := s.Verify(ctx, issued.ChallengeID, mailer.code, "ip-"+email, "")
	if err != nil {
		t.Fatal(err)
	}
	if user, err := s.Session(ctx, login.Token); err != nil || user.Email != email {
		t.Fatal("session not found", err)
	}
	if _, err = s.Verify(ctx, issued.ChallengeID, mailer.code, "ip-"+email, ""); !errors.Is(err, ErrInvalidCode) {
		t.Fatal("code replay accepted", err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE user_id=$1`, login.User.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate sessions", count, err)
	}
	if err = s.Revoke(ctx, login.User.ID, login.Token, false); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Session(ctx, login.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatal("revoked session accepted")
	}
}
func TestPostgresOTPAttemptsExpiryAndResend(t *testing.T) {
	t.Run("attempt limit", func(t *testing.T) {
		s, m, _ := postgresService(t)
		ctx := context.Background()
		email := address(t)
		issued, err := s.Request(ctx, email, email)
		if err != nil {
			t.Fatal(err)
		}
		correct := m.code
		wrong := "000000"
		if wrong == correct {
			wrong = "000001"
		}
		for i := 0; i < 5; i++ {
			if _, err = s.Verify(ctx, issued.ChallengeID, wrong, email, ""); !errors.Is(err, ErrInvalidCode) {
				t.Fatal(err)
			}
		}
		if _, err = s.Verify(ctx, issued.ChallengeID, correct, email, ""); !errors.Is(err, ErrInvalidCode) {
			t.Fatal("exhausted code accepted")
		}
	})
	t.Run("expiry", func(t *testing.T) {
		s, m, _ := postgresService(t)
		ctx := context.Background()
		email := address(t)
		now := time.Now().UTC()
		s.now = func() time.Time { return now }
		issued, err := s.Request(ctx, email, email)
		if err != nil {
			t.Fatal(err)
		}
		now = now.Add(CodeLifetime)
		if _, err = s.Verify(ctx, issued.ChallengeID, m.code, email, ""); !errors.Is(err, ErrInvalidCode) {
			t.Fatal("expired code accepted")
		}
	})
	t.Run("resend", func(t *testing.T) {
		s, m, _ := postgresService(t)
		ctx := context.Background()
		email := address(t)
		now := time.Now().UTC()
		s.now = func() time.Time { return now }
		first, err := s.Request(ctx, email, email)
		if err != nil {
			t.Fatal(err)
		}
		old := m.code
		if _, err = s.Request(ctx, email, email); !errors.Is(err, ErrRateLimited) {
			t.Fatal("resend cooldown bypassed")
		}
		now = now.Add(ResendDelay)
		second, err := s.Request(ctx, email, email)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.Verify(ctx, first.ChallengeID, old, email, ""); !errors.Is(err, ErrInvalidCode) {
			t.Fatal("superseded code accepted")
		}
		if _, err = s.Verify(ctx, second.ChallengeID, m.code, email, ""); err != nil {
			t.Fatal(err)
		}
	})
}
func TestPostgresConcurrentVerificationCreatesOneSession(t *testing.T) {
	s, m, pool := postgresService(t)
	ctx := context.Background()
	email := address(t)
	issued, err := s.Request(ctx, email, email)
	if err != nil {
		t.Fatal(err)
	}
	code := m.code
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := s.Verify(ctx, issued.ChallengeID, code, email, ""); results <- err }()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrInvalidCode) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatal("verification was not atomic", success)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions s JOIN auth_identities i ON i.user_id=s.user_id WHERE i.email=$1`, email).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate session", count, err)
	}
}
func TestPostgresSessionRotationAndOwnerScopedRevocation(t *testing.T) {
	s, m, _ := postgresService(t)
	ctx := context.Background()
	now := time.Now().UTC()
	s.now = func() time.Time { return now }
	a, b := address(t), address(t)
	issue := func(email, previous string) Login {
		t.Helper()
		issued, err := s.Request(ctx, email, email)
		if err != nil {
			t.Fatal(err)
		}
		login, err := s.Verify(ctx, issued.ChallengeID, m.code, email, previous)
		if err != nil {
			t.Fatal(err)
		}
		return login
	}
	first := issue(a, "")
	other := issue(b, "")
	now = now.Add(ResendDelay)
	second := issue(a, first.Token)
	if _, err := s.Session(ctx, first.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatal("old session survived rotation")
	}
	if err := s.Revoke(ctx, second.User.ID, other.Token, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Session(ctx, other.Token); err != nil {
		t.Fatal("another user's session revoked")
	}
	now = now.Add(ResendDelay)
	third := issue(a, "")
	if err := s.Revoke(ctx, second.User.ID, second.Token, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Session(ctx, second.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatal("logout-all did not revoke own session")
	}
	if _, err := s.Session(ctx, other.Token); err != nil {
		t.Fatal("logout-all affected another user")
	}
	if _, err := s.Session(ctx, third.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatal("logout-all left another own session active")
	}
	now = now.Add(SessionLifetime)
	if _, err := s.Session(ctx, other.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatal("expired session accepted")
	}
}

func TestPostgresDeliveryFailurePreservesPreviousCode(t *testing.T) {
	s, m, _ := postgresService(t)
	ctx := context.Background()
	now := time.Now().UTC()
	s.now = func() time.Time { return now }
	email := address(t)
	first, err := s.Request(ctx, email, email)
	if err != nil {
		t.Fatal(err)
	}
	code := m.code
	now = now.Add(ResendDelay)
	m.fail = true
	if _, err = s.Request(ctx, email, email); !errors.Is(err, ErrDelivery) {
		t.Fatal(err)
	}
	if _, err = s.Verify(ctx, first.ChallengeID, code, email, ""); err != nil {
		t.Fatal("failed resend destroyed previous code", err)
	}
}
func TestPostgresRateLimits(t *testing.T) {
	t.Run("email", func(t *testing.T) {
		s, m, _ := postgresService(t)
		ctx := context.Background()
		now := time.Now().UTC()
		s.now = func() time.Time { return now }
		email := address(t)
		for i := 0; i < 5; i++ {
			if _, err := s.Request(ctx, email, email); err != nil {
				t.Fatal(err)
			}
			now = now.Add(ResendDelay)
		}
		if _, err := s.Request(ctx, email, email); !errors.Is(err, ErrRateLimited) {
			t.Fatal("email limit bypassed", err)
		}
		if m.sent != 5 {
			t.Fatal("mail sent over limit")
		}
	})
	t.Run("ip", func(t *testing.T) {
		s, m, _ := postgresService(t)
		ctx := context.Background()
		ip := address(t)
		for i := 0; i < 20; i++ {
			if _, err := s.Request(ctx, address(t), ip); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.Request(ctx, address(t), ip); !errors.Is(err, ErrRateLimited) {
			t.Fatal("IP limit bypassed", err)
		}
		if m.sent != 20 {
			t.Fatal("mail sent over limit")
		}
	})
	t.Run("verification ip", func(t *testing.T) {
		s, _, _ := postgresService(t)
		ctx := context.Background()
		ip := address(t)
		for i := 0; i < 100; i++ {
			if _, err := s.Verify(ctx, strings.Repeat("x", 43), "123456", ip, ""); !errors.Is(err, ErrInvalidCode) {
				t.Fatal(err)
			}
		}
		if _, err := s.Verify(ctx, strings.Repeat("x", 43), "123456", ip, ""); !errors.Is(err, ErrRateLimited) {
			t.Fatal("verification IP limit bypassed", err)
		}
	})
}
