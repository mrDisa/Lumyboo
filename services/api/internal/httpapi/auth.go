package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"lumyboo/services/api/internal/auth"
	"lumyboo/services/api/internal/shelf"
)

type AuthOptions struct {
	Shelf          shelf.Store
	Service        *auth.Service
	Origin         string
	SecureCookies  bool
	TestDelivery   bool
	TrustedProxies []netip.Prefix
}
type authHandler struct{ AuthOptions }
type sessionView struct {
	User      auth.User `json:"user"`
	CSRFToken string    `json:"csrfToken"`
}

func (h authHandler) cookieName() string {
	if h.SecureCookies {
		return "__Host-lumyboo_session"
	}
	return "lumyboo_session"
}
func (h authHandler) cookie(r *http.Request) string {
	cookie, err := r.Cookie(h.cookieName())
	if err != nil {
		return ""
	}
	return cookie.Value
}
func (h authHandler) setCookie(w http.ResponseWriter, value string, expires time.Time) {
	age := int(auth.SessionLifetime.Seconds())
	if value == "" {
		age = -1
		expires = time.Unix(1, 0)
	}
	http.SetCookie(w, &http.Cookie{Name: h.cookieName(), Value: value, Path: "/", Secure: h.SecureCookies, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: age, Expires: expires})
}
func mountAuth(r chi.Router, options AuthOptions) {
	h := authHandler{options}
	r.Route("/api/v1/auth", func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if h.Service == nil {
					failure(w, req, 503, "auth_unavailable", "Вход пока недоступен. Попробуй позже.")
					return
				}
				if req.Method != http.MethodGet && req.Header.Get("Origin") != h.Origin {
					failure(w, req, 403, "invalid_origin", "Запрос разрешён только из приложения.")
					return
				}
				if req.Header.Get("Sec-Fetch-Site") == "cross-site" {
					failure(w, req, 403, "invalid_origin", "Запрос разрешён только из приложения.")
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		r.Post("/code", h.requestCode)
		r.Post("/verify", h.verify)
		r.Get("/session", h.session)
		r.Post("/logout", h.logout(false))
		r.Post("/logout-all", h.logout(true))
	})
}
func decodeJSON(w http.ResponseWriter, r *http.Request, value any) error {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		return errors.New("expected JSON")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2048)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("expected one JSON object")
	}
	return nil
}
func (h authHandler) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "unknown"
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return "unknown"
	}
	peer = peer.Unmap()
	trusted := func(ip netip.Addr) bool {
		for _, prefix := range h.TrustedProxies {
			if prefix.Contains(ip) {
				return true
			}
		}
		return false
	}
	if !trusted(peer) {
		return peer.String()
	}
	chain := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(chain) - 1; i >= 0; i-- {
		ip, err := netip.ParseAddr(strings.TrimSpace(chain[i]))
		if err != nil {
			return peer.String()
		}
		ip = ip.Unmap()
		if !trusted(ip) || i == 0 {
			return ip.String()
		}
	}
	return peer.String()
}

func authFailure(w http.ResponseWriter, r *http.Request, err error) {
	var rate *auth.RateError
	switch {
	case errors.As(err, &rate):
		w.Header().Set("Retry-After", strconv.Itoa(rate.RetryAfter))
		failure(w, r, 429, "rate_limited", "Слишком много попыток. Подожди перед повторной отправкой.")
	case errors.Is(err, auth.ErrEmail):
		failure(w, r, 400, "invalid_email", "Проверь адрес электронной почты.")
	case errors.Is(err, auth.ErrInvalidCode):
		failure(w, r, 400, "invalid_code", "Код неверный, истёк или уже использован. Запроси новый код при необходимости.")
	case errors.Is(err, auth.ErrUnauthenticated):
		failure(w, r, 401, "unauthenticated", "Нужно войти в аккаунт.")
	case errors.Is(err, auth.ErrDelivery):
		w.Header().Set("Retry-After", "60")
		failure(w, r, 503, "delivery_unavailable", "Не удалось доставить код. Попробуй ещё раз через минуту.")
	default:
		failure(w, r, 503, "auth_unavailable", "Сервис входа временно недоступен. Попробуй ещё раз.")
	}
}
func (h authHandler) requestCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if decodeJSON(w, r, &body) != nil {
		failure(w, r, 400, "invalid_request", "Проверь формат запроса.")
		return
	}
	result, err := h.Service.Request(r.Context(), body.Email, h.clientIP(r))
	if err != nil {
		authFailure(w, r, err)
		return
	}
	delivery := "email"
	if h.TestDelivery {
		delivery = "test"
	}
	respond(w, 202, struct {
		auth.Issued
		Delivery string `json:"delivery"`
	}{Issued: result, Delivery: delivery})
}
func (h authHandler) verify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ChallengeID string `json:"challengeId"`
		Code        string `json:"code"`
	}
	if decodeJSON(w, r, &body) != nil {
		failure(w, r, 400, "invalid_request", "Проверь формат запроса.")
		return
	}
	result, err := h.Service.Verify(r.Context(), body.ChallengeID, body.Code, h.clientIP(r), h.cookie(r))
	if err != nil {
		authFailure(w, r, err)
		return
	}
	h.setCookie(w, result.Token, result.ExpiresAt)
	respond(w, 200, sessionView{User: result.User, CSRFToken: result.CSRFToken})
}
func (h authHandler) session(w http.ResponseWriter, r *http.Request) {
	token := h.cookie(r)
	user, err := h.Service.Session(r.Context(), token)
	if err != nil {
		if errors.Is(err, auth.ErrUnauthenticated) {
			h.setCookie(w, "", time.Time{})
		}
		authFailure(w, r, err)
		return
	}
	respond(w, 200, sessionView{User: user, CSRFToken: h.Service.CSRF(token)})
}
func (h authHandler) logout(all bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := h.cookie(r)
		user, err := h.Service.Session(r.Context(), token)
		if err != nil {
			authFailure(w, r, err)
			return
		}
		if !h.Service.ValidCSRF(token, r.Header.Get("X-CSRF-Token")) {
			failure(w, r, 403, "invalid_csrf", "Не удалось подтвердить запрос. Обнови страницу и повтори попытку.")
			return
		}
		if err = h.Service.Revoke(r.Context(), user.ID, token, all); err != nil {
			authFailure(w, r, err)
			return
		}
		h.setCookie(w, "", time.Time{})
		w.WriteHeader(http.StatusNoContent)
	}
}
