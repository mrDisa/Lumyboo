package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

func mountShelf(r chi.Router, options AuthOptions) {
	h := authHandler{options}
	r.Route("/api/v1/shelf", func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if h.Service == nil || h.Shelf == nil {
					failure(w, req, 503, "shelf_unavailable", "Полка аккаунта временно недоступна.")
					return
				}
				if req.Header.Get("Sec-Fetch-Site") == "cross-site" || req.Method != http.MethodGet && req.Header.Get("Origin") != h.Origin {
					failure(w, req, 403, "invalid_origin", "Запрос разрешён только из приложения.")
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		r.Get("/", h.accountShelf)
		r.Post("/import", h.importShelf)
	})
}
func (h authHandler) accountShelf(w http.ResponseWriter, r *http.Request) {
	user, err := h.Service.Session(r.Context(), h.cookie(r))
	if err != nil {
		authFailure(w, r, err)
		return
	}
	ids, err := h.Shelf.List(r.Context(), user.ID)
	if err != nil {
		failure(w, r, 503, "shelf_unavailable", "Не удалось загрузить полку аккаунта.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "bookIds": ids})
}
func (h authHandler) importShelf(w http.ResponseWriter, r *http.Request) {
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
		AccountID string   `json:"accountId"`
		BookIDs   []string `json:"bookIds"`
	}
	if decodeJSON(w, r, &body) != nil || len(body.BookIDs) == 0 || len(body.BookIDs) > 100 {
		failure(w, r, 400, "invalid_request", "Выбери от 1 до 100 книг для переноса.")
		return
	}
	// This is an assertion, never an authority: ownership comes from the cookie.
	// It prevents a stale tab from importing into a newly signed-in account.
	if body.AccountID != user.ID {
		failure(w, r, 409, "account_changed", "Аккаунт изменился. Открой профиль и повтори перенос.")
		return
	}
	var books []Book
	if json.Unmarshal(seed, &books) != nil {
		failure(w, r, 503, "shelf_unavailable", "Каталог временно недоступен.")
		return
	}
	allowed := make(map[string]bool)
	for _, book := range books {
		allowed[book.ID] = true
	}
	seen := make(map[string]bool)
	ids := make([]string, 0, len(body.BookIDs))
	for _, id := range body.BookIDs {
		if !allowed[id] {
			failure(w, r, 400, "unknown_book", "В гостевой полке есть книга, недоступная в текущем каталоге.")
			return
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	result, err := h.Shelf.Import(r.Context(), user.ID, ids)
	if err != nil {
		failure(w, r, 503, "shelf_unavailable", "Не удалось перенести полку. Можно безопасно повторить.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "bookIds": result})
}
