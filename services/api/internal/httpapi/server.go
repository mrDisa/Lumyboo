package httpapi

import (
	"context"
	_ "embed"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

//go:embed catalog.json
var seed []byte

type Book struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Author      string `json:"author"`
	Genre       string `json:"genre"`
	Year        string `json:"year"`
	Cover       int    `json:"cover"`
	Description string `json:"description"`
	Kind        string `json:"kind"`
	Version     string `json:"version"`
	URL         string `json:"url"`
	SHA256      string `json:"sha256"`
	Bytes       int    `json:"bytes"`
	Rights      string `json:"rights"`
}

type Pinger interface{ Ping(context.Context) error }

func New(database Pinger) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.Recoverer, middleware.Timeout(15*time.Second))
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("X-Request-ID", middleware.GetReqID(req.Context()))
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Cache-Control", "no-store")
			next.ServeHTTP(w, req)
		})
	})
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if database == nil {
			failure(w, r, 503, "database_unavailable", "Database is not configured")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if database.Ping(ctx) != nil {
			failure(w, r, 503, "database_unavailable", "Database is unavailable")
			return
		}
		respond(w, 200, map[string]string{"status": "ready"})
	})
	r.Get("/api/v1/catalog", catalog)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) { failure(w, r, 404, "not_found", "Route not found") })
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		failure(w, r, 405, "method_not_allowed", "Method not allowed")
	})
	return r
}

func catalog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	offset, ok := bounded(q.Get("offset"), 0, 0, 1_000_000)
	if !ok {
		failure(w, r, 400, "invalid_offset", "offset must be a non-negative integer")
		return
	}
	limit, ok := bounded(q.Get("limit"), 20, 1, 50)
	if !ok {
		failure(w, r, 400, "invalid_limit", "limit must be between 1 and 50")
		return
	}
	query := strings.ToLower(strings.TrimSpace(q.Get("q")))
	if len([]rune(query)) > 200 {
		failure(w, r, 400, "invalid_query", "Search is too long")
		return
	}
	var books []Book
	if err := json.Unmarshal(seed, &books); err != nil {
		failure(w, r, 500, "catalog_unavailable", "Catalog is unavailable")
		return
	}
	filtered := make([]Book, 0)
	for _, book := range books {
		if (q.Get("genre") == "" || book.Genre == q.Get("genre")) && strings.Contains(strings.ToLower(book.Title+" "+book.Author), query) {
			filtered = append(filtered, book)
		}
	}
	total := len(filtered)
	start := min(offset, total)
	end := min(start+limit, total)
	respond(w, 200, map[string]any{"items": filtered[start:end], "total": total, "offset": offset, "limit": limit})
}
func bounded(s string, fallback, low, high int) (int, bool) {
	if s == "" {
		return fallback, true
	}
	n, err := strconv.Atoi(s)
	return n, err == nil && n >= low && n <= high
}
func failure(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	respond(w, status, map[string]any{"error": map[string]string{"code": code, "message": message, "requestId": middleware.GetReqID(r.Context())}})
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
