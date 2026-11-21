// Package telegrambot provides a minimal private-chat entry point to Lumyboo.
// Telegram identity is never used to sign in to a reader account.
package telegrambot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Bot struct {
	token, appURL, baseURL string
	client                 *http.Client
}
type Update struct {
	ID      int64    `json:"update_id"`
	Message *Message `json:"message"`
}
type Message struct {
	Text string `json:"text"`
	Chat struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"chat"`
}

func New(token, appURL string) (*Bot, error) {
	if !regexp.MustCompile(`^[0-9]+:[A-Za-z0-9_-]{20,}$`).MatchString(token) {
		return nil, errors.New("set a valid TELEGRAM_BOT_TOKEN")
	}
	parsed, err := url.Parse(appURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("set MINI_APP_URL to the deployed HTTPS application URL, including /app")
	}
	return &Bot{token: token, appURL: parsed.String(), baseURL: "https://api.telegram.org", client: &http.Client{Timeout: 40 * time.Second}}, nil
}
func (b *Bot) call(ctx context.Context, method string, payload any, output any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return errors.New("invalid Telegram payload")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+"/bot"+b.token+"/"+method, bytes.NewReader(raw))
	if err != nil {
		return errors.New("invalid Telegram request")
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := b.client.Do(request)
	// HTTP errors can contain the token in the request URL. Never wrap or log them.
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("Telegram connection failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Telegram HTTP status %d", response.StatusCode)
	}
	var envelope struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&envelope) != nil || !envelope.OK {
		return errors.New("Telegram rejected the request")
	}
	if output != nil && json.Unmarshal(envelope.Result, output) != nil {
		return errors.New("unreadable Telegram response")
	}
	return nil
}
func (b *Bot) Configure(ctx context.Context) (string, error) {
	var identity struct {
		Username string `json:"username"`
	}
	if err := b.call(ctx, "getMe", struct{}{}, &identity); err != nil {
		return "", err
	}
	menu := map[string]any{"menu_button": map[string]any{"type": "web_app", "text": "Читать", "web_app": map[string]string{"url": b.appURL}}}
	if err := b.call(ctx, "setChatMenuButton", menu, nil); err != nil {
		return "", err
	}
	return identity.Username, nil
}
func (b *Bot) Handle(ctx context.Context, update Update) error {
	if update.Message == nil || update.Message.Chat.Type != "private" {
		return nil
	}
	words := strings.Fields(update.Message.Text)
	if len(words) == 0 {
		return nil
	}
	command := strings.SplitN(words[0], "@", 2)[0]
	if command != "/start" && command != "/help" {
		return nil
	}
	payload := map[string]any{"chat_id": update.Message.Chat.ID, "text": "Привет! Это Lumyboo — хорошие книги в твоём ритме.\n\nОткрой мини-приложение, выбери историю и начни читать. Для аккаунта используется вход по email внутри приложения.", "reply_markup": map[string]any{"inline_keyboard": [][]any{{map[string]any{"text": "Открыть Lumyboo", "web_app": map[string]string{"url": b.appURL}}}}}}
	return b.call(ctx, "sendMessage", payload, nil)
}
func (b *Bot) Run(ctx context.Context, log *slog.Logger) error {
	var offset int64
	for ctx.Err() == nil {
		var updates []Update
		err := b.call(ctx, "getUpdates", map[string]any{"offset": offset, "timeout": 25, "allowed_updates": []string{"message"}}, &updates)
		if err == nil {
			for _, update := range updates {
				if err = b.Handle(ctx, update); err != nil {
					break
				}
				if update.ID >= offset {
					offset = update.ID + 1
				}
			}
		}
		if err != nil && ctx.Err() == nil {
			log.Warn("Telegram polling will retry", "error", err)
			timer := time.NewTimer(5 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
			case <-timer.C:
			}
		}
	}
	return ctx.Err()
}
