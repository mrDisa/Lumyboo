package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"

	"github.com/go-chi/chi/v5"
	"lumyboo/services/api/internal/bookmarks"
	"lumyboo/services/api/internal/positions"
)

var operationUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func mountPositions(r chi.Router, options AuthOptions) {
	h := authHandler{options}
	r.Route("/api/v1/positions", func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if h.Service == nil || h.Positions == nil {
					failure(w, req, 503, "positions_unavailable", "Места чтения аккаунта временно недоступны.")
					return
				}
				if req.Header.Get("Sec-Fetch-Site") == "cross-site" || req.Method != http.MethodGet && req.Header.Get("Origin") != h.Origin {
					failure(w, req, 403, "invalid_origin", "Запрос разрешён только из приложения.")
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		r.Get("/", h.accountPositions)
		r.Post("/choose", h.choosePosition)
	})
}
func (h authHandler) accountPositions(w http.ResponseWriter, r *http.Request) {
	user, err := h.Service.Session(r.Context(), h.cookie(r))
	if err != nil {
		authFailure(w, r, err)
		return
	}
	result, err := h.Positions.List(r.Context(), user.ID)
	if err != nil {
		failure(w, r, 503, "positions_unavailable", "Не удалось загрузить места чтения.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "positions": result})
}
func (h authHandler) choosePosition(w http.ResponseWriter, r *http.Request) {
	token := h.cookie(r)
	user, err := h.Service.Session(r.Context(), token)
	if err != nil {
		authFailure(w, r, err)
		return
	}
	if !h.Service.ValidCSRF(token, r.Header.Get("X-CSRF-Token")) {
		failure(w, r, 403, "invalid_csrf", "Обнови страницу и повтори перенос.")
		return
	}
	var body struct {
		AccountID        string `json:"accountId"`
		OperationID      string `json:"operationId"`
		ExpectedRevision *int64 `json:"expectedRevision"`
		Position         struct {
			BookID    string   `json:"bookId"`
			Version   string   `json:"version"`
			Chapter   *int     `json:"chapter"`
			Paragraph string   `json:"paragraph"`
			Offset    *float64 `json:"offset"`
		} `json:"position"`
	}
	if decodeJSON(w, r, &body) != nil || !operationUUID.MatchString(body.OperationID) || body.ExpectedRevision == nil || *body.ExpectedRevision < 0 || *body.ExpectedRevision >= 9007199254740991 || body.Position.Chapter == nil || body.Position.Offset == nil {
		failure(w, r, 400, "invalid_request", "Проверь выбранное место чтения.")
		return
	}
	if body.AccountID != user.ID {
		failure(w, r, 409, "account_changed", "Аккаунт изменился. Открой профиль заново.")
		return
	}
	entry := bookmarks.Entry{BookID: body.Position.BookID, Version: body.Position.Version, Chapter: *body.Position.Chapter, Paragraph: body.Position.Paragraph, Offset: *body.Position.Offset}
	var locations map[string]editionLocations
	if json.Unmarshal(bookmarkLocations, &locations) != nil {
		failure(w, r, 503, "positions_unavailable", "Каталог временно недоступен.")
		return
	}
	if !validBookmark(entry, locations) {
		failure(w, r, 400, "invalid_position", "Место не соответствует текущей версии книги, главе или абзацу.")
		return
	}
	choice := positions.Choice{OperationID: body.OperationID, ExpectedRevision: *body.ExpectedRevision, Position: positions.Locator{BookID: entry.BookID, Version: entry.Version, Chapter: entry.Chapter, Paragraph: entry.Paragraph, Offset: entry.Offset}}
	result, err := h.Positions.Choose(r.Context(), user.ID, choice)
	switch {
	case errors.Is(err, positions.ErrConflict):
		failure(w, r, 409, "position_conflict", "Место аккаунта изменилось. Сравни варианты ещё раз.")
		return
	case errors.Is(err, positions.ErrOperationReused):
		failure(w, r, 409, "operation_reused", "Этот запрос уже использован для другого места. Открой сравнение заново.")
		return
	case err != nil:
		failure(w, r, 503, "positions_unavailable", "Не удалось сохранить место. Можно безопасно повторить этот запрос.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "position": result})
}
