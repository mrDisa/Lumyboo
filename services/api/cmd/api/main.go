package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"lumyboo/services/api/internal/auth"
	"lumyboo/services/api/internal/bookmarks"
	"lumyboo/services/api/internal/challenges"
	"lumyboo/services/api/internal/dailygoals"
	"lumyboo/services/api/internal/httpapi"
	"lumyboo/services/api/internal/positions"
	"lumyboo/services/api/internal/readingcoverage"
	"lumyboo/services/api/internal/readingsessions"
	"lumyboo/services/api/internal/shelf"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var database httpapi.Pinger
	var pool *pgxpool.Pool
	config, err := auth.LoadConfig(os.Getenv)
	if err != nil {
		slog.Error("invalid authentication configuration", "error", err)
		os.Exit(1)
	}
	if url := os.Getenv("DATABASE_URL"); url != "" {
		var err error
		pool, err = pgxpool.New(ctx, url)
		if err != nil {
			slog.Error("database configuration failed")
			os.Exit(1)
		}
		defer pool.Close()
		database = httpapi.PostgresReadiness{Pool: pool}
	}
	var authentication httpapi.AuthOptions
	if config != nil {
		if pool == nil {
			slog.Error("authentication requires DATABASE_URL")
			os.Exit(1)
		}
		store := auth.NewPostgres(pool)
		service, err := auth.New(store, auth.SMTPMailer{Config: config.SMTP}, config.Secret)
		if err != nil {
			slog.Error("invalid authentication configuration")
			os.Exit(1)
		}
		authentication = httpapi.AuthOptions{Challenges: challenges.Postgres{Pool: pool}, DailyGoals: dailygoals.Postgres{Pool: pool}, ReadingCoverage: readingcoverage.Postgres{Pool: pool}, ReadingSessions: readingsessions.Postgres{Pool: pool}, Positions: positions.Postgres{Pool: pool}, Bookmarks: bookmarks.Postgres{Pool: pool}, Shelf: shelf.Postgres{Pool: pool}, Service: service, Origin: config.Origin, SecureCookies: config.SecureCookies, TestDelivery: config.SMTP.AllowInsecure, TrustedProxies: config.TrustedProxies}
		go func() {
			ticker := time.NewTicker(15 * time.Minute)
			defer ticker.Stop()
			for {
				cleanup, cancel := context.WithTimeout(ctx, 5*time.Second)
				err := store.Cleanup(cleanup)
				cancel()
				if err != nil && ctx.Err() == nil {
					slog.Warn("authentication cleanup failed")
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	}
	address := os.Getenv("API_ADDRESS")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	server := &http.Server{Addr: address, Handler: httpapi.New(database, authentication), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	slog.Info("api listening", "address", address)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("api stopped", "error", err)
		os.Exit(1)
	}
}
