package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCatalogSearchAndPagination(t *testing.T) {
	handler := New(nil)
	var books []Book
	if err := json.Unmarshal(seed, &books); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		path                 string
		status, total, count int
	}{
		{"/api/v1/catalog?q=Достоевский", 200, 4, 4},
		{"/api/v1/catalog?q=Гоголь", 200, 5, 5},
		{"/api/v1/catalog?q=Игрок", 200, 2, 2},
		{"/api/v1/catalog?q=Толстой", 200, 4, 4},
		{"/api/v1/catalog?q=Чехов", 200, 3, 3},
		{"/api/v1/catalog?q=Барышня-крестьянка", 200, 1, 1},
		{"/api/v1/catalog?offset=999", 200, len(books), 0},
		{"/api/v1/catalog?limit=1", 200, len(books), 1},
		{"/api/v1/catalog?limit=0", 400, 0, 0},
		{"/api/v1/catalog?offset=-1", 400, 0, 0},
	} {
		t.Run(test.path, func(t *testing.T) {
			r := httptest.NewRecorder()
			handler.ServeHTTP(r, httptest.NewRequest("GET", test.path, nil))
			if r.Code != test.status {
				t.Fatalf("status=%d: %s", r.Code, r.Body)
			}
			if r.Header().Get("X-Request-ID") == "" {
				t.Fatal("missing request id")
			}
			if test.status == 200 {
				var body struct {
					Items []Book
					Total int
				}
				if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if body.Total != test.total || len(body.Items) != test.count {
					t.Fatalf("unexpected page: %+v", body)
				}
			}
		})
	}
}
func TestNoFalseReadiness(t *testing.T) {
	r := httptest.NewRecorder()
	New(nil).ServeHTTP(r, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if r.Code != 503 {
		t.Fatalf("expected 503, got %d", r.Code)
	}
}
