package httpapi

import (
	_ "embed"
	"encoding/json"
	"math"
	"net/http"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"lumyboo/services/api/internal/bookmarks"
)

//go:embed bookmark-locations.json
var bookmarkLocations []byte

type editionLocations struct {
	Version  string     `json:"version"`
	Chapters [][]string `json:"chapters"`
}

func validBookmark(entry bookmarks.Entry, locations map[string]editionLocations) bool {
	edition, ok := locations[entry.BookID]
	if !ok || entry.Version != edition.Version || entry.Chapter < 0 || entry.Chapter >= len(edition.Chapters) || math.IsNaN(entry.Offset) || math.IsInf(entry.Offset, 0) || entry.Offset < 0 || entry.Offset >= 1 || utf8.RuneCountInString(entry.Label) > 200 {
		return false
	}
	for _, id := range edition.Chapters[entry.Chapter] {
		if id == entry.Paragraph {
			return true
		}
	}
	return false
}
func mountBookmarks(r chi.Router, options AuthOptions) {
	h := authHandler{options}
	r.Route("/api/v1/bookmarks", func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if h.Service == nil || h.Bookmarks == nil {
					failure(w, req, 503, "bookmarks_unavailable", "Закладки аккаунта временно недоступны.")
					return
				}
				if req.Header.Get("Sec-Fetch-Site") == "cross-site" || req.Method != http.MethodGet && req.Header.Get("Origin") != h.Origin {
					failure(w, req, 403, "invalid_origin", "Запрос разрешён только из приложения.")
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		r.Get("/", h.accountBookmarks)
		r.Post("/import", h.importBookmarks)
	})
}
func (h authHandler) accountBookmarks(w http.ResponseWriter, r *http.Request) {
	user, err := h.Service.Session(r.Context(), h.cookie(r))
	if err != nil {
		authFailure(w, r, err)
		return
	}
	entries, err := h.Bookmarks.List(r.Context(), user.ID)
	if err != nil {
		failure(w, r, 503, "bookmarks_unavailable", "Не удалось загрузить закладки аккаунта.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "bookmarks": entries})
}
func (h authHandler) importBookmarks(w http.ResponseWriter, r *http.Request) {
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
		AccountID string `json:"accountId"`
		Bookmarks []struct {
			BookID    string   `json:"bookId"`
			Version   string   `json:"version"`
			Chapter   *int     `json:"chapter"`
			Paragraph string   `json:"paragraph"`
			Offset    *float64 `json:"offset"`
			Label     *string  `json:"label"`
		} `json:"bookmarks"`
	}
	if decodeJSONLimit(w, r, &body, 256*1024) != nil || len(body.Bookmarks) == 0 || len(body.Bookmarks) > 100 {
		failure(w, r, 400, "invalid_request", "Выбери от 1 до 100 закладок для переноса.")
		return
	}
	if body.AccountID != user.ID {
		failure(w, r, 409, "account_changed", "Аккаунт изменился. Открой профиль и повтори перенос.")
		return
	}
	var locations map[string]editionLocations
	if json.Unmarshal(bookmarkLocations, &locations) != nil {
		failure(w, r, 503, "bookmarks_unavailable", "Каталог временно недоступен.")
		return
	}
	entries := make([]bookmarks.Entry, 0, len(body.Bookmarks))
	for _, input := range body.Bookmarks {
		if input.Chapter == nil || input.Offset == nil || input.Label == nil {
			failure(w, r, 400, "invalid_bookmark", "У закладки отсутствуют обязательные поля.")
			return
		}
		entry := bookmarks.Entry{BookID: input.BookID, Version: input.Version, Chapter: *input.Chapter, Paragraph: input.Paragraph, Offset: *input.Offset, Label: *input.Label}
		if !validBookmark(entry, locations) {
			failure(w, r, 400, "invalid_bookmark", "Закладка не соответствует текущему тексту. Проверь версию книги, главу и абзац.")
			return
		}
		entries = append(entries, entry)
	}
	result, err := h.Bookmarks.Import(r.Context(), user.ID, entries)
	if err != nil {
		failure(w, r, 503, "bookmarks_unavailable", "Не удалось скопировать закладки. Можно безопасно повторить.")
		return
	}
	respond(w, 200, map[string]any{"accountId": user.ID, "bookmarks": result})
}
