package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"lumyboo/services/api/internal/bookmarks"
	"lumyboo/services/api/internal/positions"
)

// Intercept only the armed successful verify, after the real handler commits.
// Hijacking closes the real TLS connection, rather than faking a client error.
type lostVerifyReply struct {
	next http.Handler
	mu   sync.Mutex
	mode string
	lost bool
}

func (f *lostVerifyReply) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.mode == "" || r.Method != "POST" || r.URL.Path != "/api/v1/auth/verify" {
		f.next.ServeHTTP(w, r)
		return
	}
	recorded := httptest.NewRecorder()
	f.next.ServeHTTP(recorded, r)
	if recorded.Code != http.StatusOK {
		for key, values := range recorded.Header() {
			w.Header()[key] = values
		}
		w.WriteHeader(recorded.Code)
		_, _ = w.Write(recorded.Body.Bytes())
		return
	}
	mode := f.mode
	f.mode, f.lost = "", true
	connection, buffer, err := w.(http.Hijacker).Hijack()
	if err != nil {
		panic(err)
	}
	defer connection.Close()
	if mode == "after-headers" {
		_, _ = fmt.Fprint(buffer, "HTTP/1.1 200 OK\r\n")
		_ = recorded.Header().Write(buffer)
		_, _ = fmt.Fprintf(buffer, "Content-Length: %d\r\nConnection: close\r\n\r\n", recorded.Body.Len())
		_ = buffer.Flush()
	}
}

func TestPostgresAccountSwitchWithLostVerifyReply(t *testing.T) {
	for _, mode := range []string{"before-headers", "after-headers"} {
		t.Run(mode, func(t *testing.T) {
			pool := journeyDatabase(t)
			var fault *lostVerifyReply
			mailbox, device := journeyServer(t, pool, func(handler http.Handler) http.Handler {
				fault = &lostVerifyReply{next: handler}
				return fault
			})
			a, independent := device(), device()
			a.login("first@example.test", mailbox)
			owner := a.session.User.ID
			if _, err := pool.Exec(context.Background(), "UPDATE auth_email_state SET last_requested_at=now()-interval '61 seconds'"); err != nil {
				t.Fatal(err)
			}
			independent.login("first@example.test", mailbox)
			entry := bookmarks.Entry{BookID: "room-for-stories", Version: "1", Chapter: 1, Paragraph: "ch-2-p-1", Offset: .25, Label: "Account A"}
			a.request("POST", "/bookmarks/import", map[string]any{"accountId": owner, "bookmarks": []bookmarks.Entry{entry}}, 200)
			locator := positions.Locator{BookID: entry.BookID, Version: entry.Version, Chapter: entry.Chapter, Paragraph: entry.Paragraph, Offset: entry.Offset}
			saved := a.request("POST", "/positions/choose", map[string]any{"accountId": owner, "operationId": journeyID(t), "expectedRevision": 0, "position": locator}, 200)
			issued := a.request("POST", "/auth/code", map[string]any{"email": "second@example.test"}, 202)
			mailbox.mu.Lock()
			code := mailbox.codes["second@example.test"]
			mailbox.mu.Unlock()

			// Both cookie jars keep using the same HTTPS origin and real API.
			fault.mu.Lock()
			fault.mode = mode
			fault.mu.Unlock()
			parsed, _ := url.Parse(a.origin)
			previousCookies := a.client.Jar.Cookies(parsed)
			body, _ := json.Marshal(map[string]any{"challengeId": issued["challengeId"], "code": code})
			req, _ := http.NewRequest("POST", a.origin+"/api/v1/auth/verify", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", a.origin)
			response, err := a.client.Do(req)
			if mode == "before-headers" {
				if err == nil {
					response.Body.Close()
					t.Fatal("lost headers unexpectedly delivered")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				_, readErr := io.ReadAll(response.Body)
				response.Body.Close()
				if response.StatusCode != 200 || readErr == nil {
					t.Fatalf("expected 200 headers and incomplete body, got %d, %v", response.StatusCode, readErr)
				}
			}
			fault.mu.Lock()
			lost := fault.lost
			fault.mu.Unlock()
			if !lost {
				t.Fatal("verify did not reach a successful commit")
			}
			if mode == "before-headers" {
				a.request("GET", "/auth/session", nil, 401)
				a.request("GET", "/positions/", nil, 401)
				a.request("GET", "/bookmarks/", nil, 401)
			} else {
				session := a.request("GET", "/auth/session", nil, 200)
				user := session["user"].(map[string]any)
				journeyEqual(t, user["email"], "second@example.test")
				if user["id"] == owner {
					t.Fatal("old account remained active")
				}
				journeyEqual(t, a.request("GET", "/positions/", nil, 200)["positions"], []any{})
				journeyEqual(t, a.request("GET", "/bookmarks/", nil, 200)["bookmarks"], []any{})
			}
			a.request("POST", "/auth/verify", map[string]any{"challengeId": issued["challengeId"], "code": code}, 400)
			// Even manually reusing the old cookie cannot reopen the revoked session.
			stale := device()
			stale.client.Jar.SetCookies(parsed, previousCookies)
			stale.request("GET", "/auth/session", nil, 401)
			if mode == "before-headers" {
				// Recover through a new OTP, never by extracting the lost cookie.
				a.request("POST", "/auth/code", map[string]any{"email": "second@example.test"}, 429)
				if _, err := pool.Exec(context.Background(), "UPDATE auth_email_state SET last_requested_at=now()-interval '61 seconds'"); err != nil {
					t.Fatal(err)
				}
				a.login("second@example.test", mailbox)
				journeyEqual(t, a.session.User.Email, "second@example.test")
				journeyEqual(t, a.request("GET", "/positions/", nil, 200)["positions"], []any{})
				journeyEqual(t, a.request("GET", "/bookmarks/", nil, 200)["bookmarks"], []any{})
			}
			journeyEqual(t, independent.request("GET", "/positions/", nil, 200)["positions"], []any{saved["position"]})
			journeyEqual(t, independent.request("GET", "/bookmarks/", nil, 200)["bookmarks"], []bookmarks.Entry{entry})
		})
	}
}
