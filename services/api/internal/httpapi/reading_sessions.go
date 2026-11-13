package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"lumyboo/services/api/internal/readingsessions"
)

func mountReadingSessions(r chi.Router, options AuthOptions) {
	h := authHandler{options}
	r.Route("/api/v1/reading-sessions", func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if h.Service == nil || h.ReadingSessions == nil {
					failure(w, req, 503, "reading_sessions_unavailable", "Записи времени временно недоступны.")
					return
				}
				if req.Header.Get("Sec-Fetch-Site") == "cross-site" || req.Method != http.MethodGet && req.Header.Get("Origin") != h.Origin {
					failure(w, req, 403, "invalid_origin", "Запрос разрешён только из приложения.")
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		r.Get("/", h.readingSessionHistory)
		r.Get("/{sessionId}", h.readingSession)
		r.Post("/apply", h.applyReadingSession)
	})
}
func (h authHandler) readingSession(w http.ResponseWriter, r *http.Request) {
	user, err := h.Service.Session(r.Context(), h.cookie(r))
	if err != nil {
		authFailure(w, r, err)
		return
	}
	id := chi.URLParam(r, "sessionId")
	if !readingsessions.ValidID(id) {
		failure(w, r, 400, "invalid_request", "Проверь запись времени.")
		return
	}
	result, err := h.ReadingSessions.Get(r.Context(), user.ID, id)
	if errors.Is(err, readingsessions.ErrNotFound) {
		failure(w, r, 404, "not_found", "Запись времени не найдена.")
		return
	}
	if err != nil {
		failure(w, r, 503, "reading_sessions_unavailable", "Не удалось загрузить запись времени.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "session": result})
}
func (h authHandler) applyReadingSession(w http.ResponseWriter, r *http.Request) {
	token := h.cookie(r)
	user, err := h.Service.Session(r.Context(), token)
	if err != nil {
		authFailure(w, r, err)
		return
	}
	if !h.Service.ValidCSRF(token, r.Header.Get("X-CSRF-Token")) {
		failure(w, r, 403, "invalid_csrf", "Обнови страницу и повтори сохранение времени.")
		return
	}
	var body struct {
		AccountID   string                 `json:"accountId"`
		OperationID string                 `json:"operationId"`
		Session     readingsessions.Report `json:"session"`
	}
	if decodeJSON(w, r, &body) != nil {
		failure(w, r, 400, "invalid_request", "Проверь запись времени.")
		return
	}
	if body.AccountID != user.ID {
		failure(w, r, 409, "account_changed", "Аккаунт изменился. Открой профиль заново.")
		return
	}
	change := readingsessions.Change{OperationID: body.OperationID, Session: body.Session}
	if !readingsessions.Valid(change) {
		failure(w, r, 400, "invalid_request", "Проверь запись времени.")
		return
	}
	// Reuse the development edition allowlist; duration alone needs no locator.
	var editions map[string]editionLocations
	if json.Unmarshal(bookmarkLocations, &editions) != nil {
		failure(w, r, 503, "reading_sessions_unavailable", "Каталог временно недоступен.")
		return
	}
	edition, ok := editions[body.Session.BookID]
	if !ok || edition.Version != body.Session.Version {
		failure(w, r, 400, "invalid_session", "Запись времени относится к недоступному изданию.")
		return
	}
	result, err := h.ReadingSessions.Apply(r.Context(), user.ID, change)
	switch {
	case errors.Is(err, readingsessions.ErrOperationReused):
		failure(w, r, 409, "operation_reused", "Этот запрос уже использован. Проверь запись времени.")
		return
	case errors.Is(err, readingsessions.ErrSessionReused):
		failure(w, r, 409, "reading_session_conflict", "Данные сессии чтения не совпадают с сохранёнными.")
		return
	case errors.Is(err, readingsessions.ErrInvalid):
		failure(w, r, 400, "invalid_request", "Проверь запись времени.")
		return
	case err != nil:
		failure(w, r, 503, "reading_sessions_unavailable", "Не удалось сохранить время. Можно безопасно повторить этот запрос.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "session": result})
}

func (h authHandler) readingSessionHistory(w http.ResponseWriter, r *http.Request) {
	user, err := h.Service.Session(r.Context(), h.cookie(r))
	if err != nil {
		authFailure(w, r, err)
		return
	}
	cursor := r.URL.Query().Get("cursor")
	limit, validLimit := bounded(r.URL.Query().Get("limit"), 20, 1, 50)
	_, _, validCursor := readingsessions.ParseCursor(cursor)
	if !validLimit || !validCursor {
		failure(w, r, 400, "invalid_request", "Проверь параметры истории времени.")
		return
	}
	result, err := h.ReadingSessions.List(r.Context(), user.ID, cursor, limit)
	if err != nil {
		failure(w, r, 503, "reading_sessions_unavailable", "Не удалось загрузить историю времени.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "items": result.Items, "nextCursor": result.NextCursor})
}
