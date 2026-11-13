package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/mail"
	"strings"
	"time"
)

var (
	ErrInvalidCode     = errors.New("invalid or expired code")
	ErrUnauthenticated = errors.New("authentication required")
	ErrDelivery        = errors.New("email delivery unavailable")
	ErrEmail           = errors.New("invalid email")
	ErrRateLimited     = errors.New("too many requests")
)

const CodeLifetime = 10 * time.Minute
const SessionLifetime = 30 * 24 * time.Hour
const ResendDelay = 60 * time.Second

type RateError struct{ RetryAfter int }

func (e *RateError) Error() string { return ErrRateLimited.Error() }
func (e *RateError) Unwrap() error { return ErrRateLimited }

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}
type Challenge struct {
	ID, Email                 string
	EmailKey, IPKey, CodeHash []byte
	CreatedAt, ExpiresAt      time.Time
}
type Attempt struct {
	ChallengeID, NewUserID                            string
	CodeHash, IPKey, SessionHash, PreviousSessionHash []byte
	Now, SessionExpiresAt                             time.Time
}
type Store interface {
	Create(context.Context, Challenge) error
	Delivered(context.Context, string, time.Time) error
	Cancel(context.Context, string) error
	Consume(context.Context, Attempt) (User, error)
	Session(context.Context, []byte, time.Time) (User, error)
	Revoke(context.Context, string, []byte, bool, time.Time) error
}
type Mailer interface {
	SendCode(context.Context, string, string, time.Duration) error
}
type Service struct {
	store  Store
	mailer Mailer
	secret []byte
	now    func() time.Time
}
type Issued struct {
	ChallengeID string `json:"challengeId"`
	ExpiresIn   int    `json:"expiresIn"`
	ResendAfter int    `json:"resendAfter"`
}

// The raw token is deliberately not a wire-format field; handlers set only a cookie.
type Login struct {
	User      User
	Token     string `json:"-"`
	CSRFToken string
	ExpiresAt time.Time
}

func New(store Store, mailer Mailer, secret []byte) (*Service, error) {
	if len(secret) < 32 {
		return nil, errors.New("AUTH_SECRET must contain at least 32 decoded bytes")
	}
	return &Service{store: store, mailer: mailer, secret: append([]byte(nil), secret...), now: func() time.Time { return time.Now().UTC() }}, nil
}
func normalizeEmail(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) > 254 || strings.ContainsAny(value, "\r\n") {
		return "", ErrEmail
	}
	for _, r := range value {
		if r > 127 {
			return "", ErrEmail
		}
	}
	address, err := mail.ParseAddress(value)
	if err != nil || address.Name != "" || address.Address != value {
		return "", ErrEmail
	}
	at := strings.LastIndexByte(value, '@')
	return value[:at] + "@" + strings.ToLower(value[at+1:]), nil
}
func (s *Service) keyed(value string) []byte {
	h := hmac.New(sha256.New, s.secret)
	_, _ = h.Write([]byte(value))
	return h.Sum(nil)
}
func tokenHash(value string) []byte { sum := sha256.Sum256([]byte(value)); return sum[:] }
func randomToken() (string, error) {
	var data [32]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data[:]), nil
}
func randomUUID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	data[6] = (data[6] & 15) | 64
	data[8] = (data[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", data[:4], data[4:6], data[6:8], data[8:10], data[10:]), nil
}
func (s *Service) Request(ctx context.Context, email, ip string) (Issued, error) {
	email, err := normalizeEmail(email)
	if err != nil {
		return Issued{}, err
	}
	id, err := randomToken()
	if err != nil {
		return Issued{}, err
	}
	number, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return Issued{}, err
	}
	code := fmt.Sprintf("%06d", number.Int64())
	now := s.now()
	c := Challenge{ID: id, Email: email, EmailKey: s.keyed("email:" + email), IPKey: s.keyed("send-ip:" + ip), CodeHash: s.keyed("otp:" + id + ":" + code), CreatedAt: now, ExpiresAt: now.Add(CodeLifetime)}
	if err = s.store.Create(ctx, c); err != nil {
		return Issued{}, err
	}
	delivery, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err = s.mailer.SendCode(delivery, email, code, CodeLifetime); err != nil {
		cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer stop()
		_ = s.store.Cancel(cleanup, id)
		return Issued{}, ErrDelivery
	}
	if err = s.store.Delivered(ctx, id, s.now()); err != nil {
		return Issued{}, err
	}
	return Issued{ChallengeID: id, ExpiresIn: int(CodeLifetime.Seconds()), ResendAfter: int(ResendDelay.Seconds())}, nil
}
func (s *Service) Verify(ctx context.Context, id, code, ip, previous string) (Login, error) {
	if len(id) != 43 || len(code) != 6 {
		return Login{}, ErrInvalidCode
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return Login{}, ErrInvalidCode
		}
	}
	token, err := randomToken()
	if err != nil {
		return Login{}, err
	}
	userID, err := randomUUID()
	if err != nil {
		return Login{}, err
	}
	now := s.now()
	a := Attempt{ChallengeID: id, CodeHash: s.keyed("otp:" + id + ":" + code), IPKey: s.keyed("verify-ip:" + ip), NewUserID: userID, SessionHash: tokenHash(token), Now: now, SessionExpiresAt: now.Add(SessionLifetime)}
	if previous != "" {
		a.PreviousSessionHash = tokenHash(previous)
	}
	user, err := s.store.Consume(ctx, a)
	if err != nil {
		return Login{}, err
	}
	return Login{User: user, Token: token, CSRFToken: s.CSRF(token), ExpiresAt: a.SessionExpiresAt}, nil
}
func (s *Service) CSRF(token string) string {
	return base64.RawURLEncoding.EncodeToString(s.keyed("csrf:" + token))
}
func (s *Service) ValidCSRF(token, value string) bool {
	return subtle.ConstantTimeCompare([]byte(s.CSRF(token)), []byte(value)) == 1
}
func (s *Service) Session(ctx context.Context, token string) (User, error) {
	if len(token) != 43 {
		return User{}, ErrUnauthenticated
	}
	return s.store.Session(ctx, tokenHash(token), s.now())
}
func (s *Service) Revoke(ctx context.Context, userID, token string, all bool) error {
	return s.store.Revoke(ctx, userID, tokenHash(token), all, s.now())
}
