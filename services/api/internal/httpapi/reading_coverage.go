package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"lumyboo/services/api/internal/readingcoverage"
)

func mountReadingCoverage(r chi.Router, options AuthOptions) {
	h := authHandler{options}
	r.Route("/api/v1/reading-coverage", func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if h.Service == nil || h.ReadingCoverage == nil {
					failure(w, req, 503, "reading_coverage_unavailable", "Фрагменты текста временно недоступны.")
					return
				}
				if req.Header.Get("Sec-Fetch-Site") == "cross-site" || req.Method != http.MethodGet && req.Header.Get("Origin") != h.Origin {
					failure(w, req, 403, "invalid_origin", "Запрос разрешён только из приложения.")
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		r.Get("/{bookId}", h.readingCoverage)
		r.Post("/apply", h.applyReadingCoverage)
	})
}

func (h authHandler) applyReadingCoverage(w http.ResponseWriter, r *http.Request) {
	token := h.cookie(r)
	user, err := h.Service.Session(r.Context(), token)
	if err != nil {
		authFailure(w, r, err)
		return
	}
	if !h.Service.ValidCSRF(token, r.Header.Get("X-CSRF-Token")) {
		failure(w, r, 403, "invalid_csrf", "Обнови страницу и повтори сохранение фрагментов.")
		return
	}
	var body struct {
		AccountID   string                   `json:"accountId"`
		OperationID string                   `json:"operationId"`
		Coverage    readingcoverage.Coverage `json:"coverage"`
	}
	if decodeJSONLimit(w, r, &body, 8192) != nil {
		failure(w, r, 400, "invalid_request", "Проверь фрагменты текста.")
		return
	}
	if body.AccountID != user.ID {
		failure(w, r, 409, "account_changed", "Аккаунт изменился. Открой профиль заново.")
		return
	}
	change := readingcoverage.Change{OperationID: body.OperationID, Coverage: body.Coverage}
	if !readingcoverage.Valid(change) {
		failure(w, r, 400, "invalid_request", "Проверь фрагменты текста.")
		return
	}
	var editions map[string]editionLocations
	if json.Unmarshal(bookmarkLocations, &editions) != nil {
		failure(w, r, 503, "reading_coverage_unavailable", "Каталог временно недоступен.")
		return
	}
	edition, ok := editions[body.Coverage.BookID]
	found := false
	if ok && edition.Version == body.Coverage.Version {
		for _, chapter := range edition.Chapters {
			for _, paragraph := range chapter {
				if paragraph == body.Coverage.Paragraph {
					found = true
				}
			}
		}
	}
	if !found {
		failure(w, r, 400, "invalid_coverage", "Фрагмент отсутствует в доступном издании.")
		return
	}
	result, err := h.ReadingCoverage.Apply(r.Context(), user.ID, change)
	switch {
	case errors.Is(err, readingcoverage.ErrOperationReused):
		failure(w, r, 409, "operation_reused", "Этот запрос уже использован. Проверь фрагменты текста.")
		return
	case errors.Is(err, readingcoverage.ErrFragmentLimit):
		failure(w, r, 409, "coverage_fragment_limit", "Не удалось сохранить дополнительные фрагменты этого абзаца.")
		return
	case errors.Is(err, readingcoverage.ErrInvalid):
		failure(w, r, 400, "invalid_request", "Проверь фрагменты текста.")
		return
	case err != nil:
		failure(w, r, 503, "reading_coverage_unavailable", "Не удалось сохранить фрагменты. Можно безопасно повторить этот запрос.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "coverage": result})
}

func (h authHandler) readingCoverage(w http.ResponseWriter, r *http.Request) {
	user, err := h.Service.Session(r.Context(), h.cookie(r))
	if err != nil {
		authFailure(w, r, err)
		return
	}
	book, version, cursor := chi.URLParam(r, "bookId"), r.URL.Query().Get("version"), r.URL.Query().Get("cursor")
	limit, ok := bounded(r.URL.Query().Get("limit"), 20, 1, 50)
	if !ok || !readingcoverage.ValidKey(book) || !readingcoverage.ValidKey(version) || cursor != "" && !readingcoverage.ValidKey(cursor) {
		failure(w, r, 400, "invalid_request", "Проверь параметры фрагментов текста.")
		return
	}
	// Reading history can include old editions. Only writes require the current
	// development allowlist; this private query is always scoped to the owner.
	result, err := h.ReadingCoverage.List(r.Context(), user.ID, book, version, cursor, limit)
	if err != nil {
		failure(w, r, 503, "reading_coverage_unavailable", "Не удалось загрузить фрагменты текста.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "items": result.Items, "nextCursor": result.NextCursor})
}
