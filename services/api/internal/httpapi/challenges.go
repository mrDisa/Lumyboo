package httpapi

import (
	"errors"
	"github.com/go-chi/chi/v5"
	"lumyboo/services/api/internal/challenges"
	"net/http"
)

func mountChallenges(r chi.Router, options AuthOptions) {
	h := authHandler{options}
	r.Post("/api/v1/challenges/action", func(w http.ResponseWriter, r *http.Request) {
		if h.Service == nil || h.Challenges == nil {
			challengeFailure(w, r, errors.New("unavailable"))
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" || r.Header.Get("Origin") != h.Origin {
			failure(w, r, 403, "invalid_origin", "Запрос разрешён только из приложения.")
			return
		}
		user, err := h.Service.Session(r.Context(), h.cookie(r))
		if err != nil {
			authFailure(w, r, err)
			return
		}
		if !h.Service.ValidCSRF(h.cookie(r), r.Header.Get("X-CSRF-Token")) {
			failure(w, r, 403, "invalid_csrf", "Обнови страницу и повтори действие.")
			return
		}
		var body struct {
			AccountID string `json:"accountId"`
			challenges.Action
		}
		if decodeJSON(w, r, &body) != nil || !challenges.ValidAction(body.Action) {
			failure(w, r, 400, "invalid_challenge_action", "Проверь код приглашения, псевдоним и цель из списка.")
			return
		}
		if body.AccountID != user.ID {
			failure(w, r, 409, "account_changed", "Аккаунт изменился. Проверь вход заново.")
			return
		}
		result, err := h.Challenges.Action(r.Context(), user.ID, body.Action)
		if err != nil {
			challengeFailure(w, r, err)
			return
		}
		respond(w, 200, map[string]any{"accountId": user.ID, "challenge": result.Challenge, "code": result.Code})
	})
	r.HandleFunc("/api/v1/challenges", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "POST" {
			failure(w, r, 405, "method_not_allowed", "Метод недоступен.")
			return
		}
		if h.Service == nil || h.Challenges == nil {
			failure(w, r, 503, "challenges_unavailable", "Челленджи временно недоступны.")
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" || r.Method != "GET" && r.Header.Get("Origin") != h.Origin {
			failure(w, r, 403, "invalid_origin", "Запрос разрешён только из приложения.")
			return
		}
		user, err := h.Service.Session(r.Context(), h.cookie(r))
		if err != nil {
			authFailure(w, r, err)
			return
		}
		if r.Method == "GET" {
			// Expected account protects against a cookie switch in another tab.
			if r.URL.Query().Get("accountId") != user.ID {
				failure(w, r, 409, "account_changed", "Аккаунт изменился. Проверь вход заново.")
				return
			}
			items, err := h.Challenges.List(r.Context(), user.ID)
			if err != nil {
				challengeFailure(w, r, err)
				return
			}
			respond(w, 200, map[string]any{"accountId": user.ID, "items": items})
			return
		}
		if !h.Service.ValidCSRF(h.cookie(r), r.Header.Get("X-CSRF-Token")) {
			failure(w, r, 403, "invalid_csrf", "Обнови страницу и повтори создание.")
			return
		}
		var body struct {
			AccountID string `json:"accountId"`
			challenges.Create
		}
		if decodeJSON(w, r, &body) != nil || !challenges.Valid(body.Create) {
			challengeFailure(w, r, challenges.ErrInvalid)
			return
		}
		if body.AccountID != user.ID {
			failure(w, r, 409, "account_changed", "Аккаунт изменился. Проверь вход заново.")
			return
		}
		result, err := h.Challenges.Create(r.Context(), user.ID, body.Create)
		if err != nil {
			challengeFailure(w, r, err)
			return
		}
		respond(w, 200, map[string]any{"accountId": user.ID, "challenge": result})
	})
}
func challengeFailure(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, challenges.ErrUnavailable):
		failure(w, r, 409, "challenge_unavailable", "Приглашение недоступно: оно отозвано, старт уже наступил или у тебя нет доступа к этому действию.")
	case errors.Is(err, challenges.ErrFull):
		failure(w, r, 409, "challenge_full", "В команде уже 10 участников. Вступить пока нельзя.")
	case errors.Is(err, challenges.ErrInvalid):
		failure(w, r, 400, "invalid_challenge", "Проверь условия: старт с завтрашнего дня, цель и длительность из списка, название и псевдоним без переносов строк.")
	case errors.Is(err, challenges.ErrConflict):
		failure(w, r, 409, "challenge_conflict", "Этот запрос уже сохранил другие условия. Обнови список челленджей.")
	default:
		failure(w, r, 503, "challenges_unavailable", "Не удалось выполнить действие с челленджем. Повтори подключение.")
	}
}
