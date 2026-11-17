package httpapi

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"lumyboo/services/api/internal/auth"
	"lumyboo/services/api/internal/bookmarks"
	"lumyboo/services/api/internal/challenges"
	"lumyboo/services/api/internal/dailygoals"
	"lumyboo/services/api/internal/positions"
	"lumyboo/services/api/internal/readingcoverage"
	"lumyboo/services/api/internal/readingsessions"
	"lumyboo/services/api/internal/shelf"
)

// Opt-in browser server, compiled only into a Go test binary by reading_journey.py.
// Only challenge calendar time changes; authentication and reading use real time.
func TestBrowserJourneyAPI(t *testing.T) {
	clockFile := os.Getenv("JOURNEY_CHALLENGE_CLOCK_FILE")
	if clockFile == "" {
		t.Skip("only started by the disposable browser journey")
	}
	database, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || !strings.HasPrefix(database.Path, "/journey_") || database.Hostname() != "127.0.0.1" {
		t.Fatal("browser journey requires a disposable loopback journey_* database")
	}
	address := os.Getenv("API_ADDRESS")
	host, _, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" {
		t.Fatal("browser journey requires a loopback API address")
	}
	now := func() time.Time {
		data, err := os.ReadFile(clockFile)
		if err != nil {
			panic(err)
		}
		value, err := time.Parse(time.RFC3339, strings.TrimSpace(string(data)))
		if err != nil {
			panic(err)
		}
		return value
	}
	_ = now()
	pool, err := pgxpool.New(context.Background(), database.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	config, err := auth.LoadConfig(os.Getenv)
	if err != nil || config == nil {
		t.Fatalf("browser journey authentication config: %v", err)
	}
	service, err := auth.New(auth.NewPostgres(pool), auth.SMTPMailer{Config: config.SMTP}, config.Secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := New(PostgresReadiness{Pool: pool}, AuthOptions{
		Service: service, Origin: config.Origin, SecureCookies: config.SecureCookies,
		TestDelivery: config.SMTP.AllowInsecure,
		Shelf:        shelf.Postgres{Pool: pool}, Positions: positions.Postgres{Pool: pool},
		Bookmarks: bookmarks.Postgres{Pool: pool}, ReadingSessions: readingsessions.Postgres{Pool: pool},
		ReadingCoverage: readingcoverage.Postgres{Pool: pool}, DailyGoals: dailygoals.Postgres{Pool: pool},
		Challenges: challenges.Postgres{Pool: pool, Now: now},
	})
	server := &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	t.Fatal(server.ListenAndServe())
}
