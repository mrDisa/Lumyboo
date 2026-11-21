package main

import (
	"context"
	"flag"
	"log/slog"
	"lumyboo/services/api/internal/telegrambot"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	configureOnly := flag.Bool("configure-only", false, "Set the Telegram app menu and exit without polling")
	flag.Parse()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	bot, err := telegrambot.New(os.Getenv("TELEGRAM_BOT_TOKEN"), os.Getenv("MINI_APP_URL"))
	if err != nil {
		logger.Error(err.Error())
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	username, err := bot.Configure(ctx)
	if err != nil {
		logger.Error("Telegram setup failed", "error", err)
		os.Exit(1)
	}
	logger.Info("Telegram bot ready", "username", username)
	if *configureOnly {
		return
	}
	if err = bot.Run(ctx, logger); err != nil && ctx.Err() == nil {
		logger.Error("Telegram bot stopped", "error", err)
		os.Exit(1)
	}
}
