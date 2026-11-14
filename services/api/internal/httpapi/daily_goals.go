package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"lumyboo/services/api/internal/dailygoals"
)

func mountDailyGoals(r chi.Router, options AuthOptions) {
	h := authHandler{options}
	r.HandleFunc("/api/v1/daily-goal", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "POST" {
			failure(w, r, 405, "method_not_allowed", "Метод недоступен.")
			return
		}
		if h.Service == nil || h.DailyGoals == nil {
			failure(w, r, 503, "daily_goal_unavailable", "Цель временно недоступна.")
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" || r.Method != "GET" && r.Header.Get("Origin") != h.Origin {
			failure(w, r, 403, "invalid_origin", "Запрос разрешён только из приложения.")
			return
		}
		token := h.cookie(r)
		user, err := h.Service.Session(r.Context(), token)
		if err != nil {
			authFailure(w, r, err)
			return
		}
		if r.Method == "GET" {
			day := r.URL.Query().Get("day")
			if day != "" && !dailygoals.ValidDay(day) {
				failure(w, r, 400, "invalid_request", "Проверь дату.")
				return
			}
			result, err := h.DailyGoals.Get(r.Context(), user.ID, day)
			if err != nil {
				dailyGoalFailure(w, r, err)
				return
			}
			respond(w, 200, map[string]any{"accountId": user.ID, "goal": result.Goal, "progress": result.Progress})
			return
		}
		if !h.Service.ValidCSRF(token, r.Header.Get("X-CSRF-Token")) {
			failure(w, r, 403, "invalid_csrf", "Обнови страницу и повтори сохранение цели.")
			return
		}
		var body struct {
			AccountID string `json:"accountId"`
			dailygoals.Change
		}
		if decodeJSON(w, r, &body) != nil || !dailygoals.Valid(body.Change) {
			failure(w, r, 400, "invalid_request", "Проверь цель и часовой пояс.")
			return
		}
		if body.AccountID != user.ID {
			failure(w, r, 409, "account_changed", "Аккаунт изменился. Открой профиль заново.")
			return
		}
		result, err := h.DailyGoals.Apply(r.Context(), user.ID, body.Change)
		if err != nil {
			dailyGoalFailure(w, r, err)
			return
		}
		respond(w, 200, map[string]any{"accountId": user.ID, "goal": result})
	})
}
func dailyGoalFailure(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, dailygoals.ErrNotFound):
		failure(w, r, 404, "daily_goal_not_found", "Настрой дневную цель.")
	case errors.Is(err, dailygoals.ErrInvalid):
		failure(w, r, 400, "invalid_request", "Дата изменилась. Обнови цель и повтори выбор.")
	case errors.Is(err, dailygoals.ErrHistoryConflict):
		failure(w, r, 409, "daily_goal_history_conflict", "В аккаунте есть чтение до настройки цели. Сними выбор ранней истории, чтобы сохранить прошлые результаты, и повтори перенос.")
	case errors.Is(err, dailygoals.ErrConflict):
		failure(w, r, 409, "daily_goal_conflict", "Цель изменилась. Обнови её и повтори выбор.")
	default:
		failure(w, r, 503, "daily_goal_unavailable", "Не удалось сохранить или загрузить цель. Повтори подключение.")
	}
}
