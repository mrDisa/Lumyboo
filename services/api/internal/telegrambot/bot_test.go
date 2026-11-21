package telegrambot

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const fakeToken = "12345:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

func TestRequiresHTTPSWithoutCredentials(t *testing.T) {
	for _, address := range []string{"http://example.test/app", "https://user:password@example.test/app", "https://example.test/app#secret", ""} {
		if _, err := New(fakeToken, address); err == nil {
			t.Fatalf("accepted %q", address)
		}
	}
	if _, err := New(fakeToken, "https://example.test/app"); err != nil {
		t.Fatal(err)
	}
}
func TestRepliesOnlyToPrivateStartOrHelpWithApplicationButton(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if !strings.HasSuffix(r.URL.Path, "/sendMessage") {
			t.Error("wrong method")
		}
		var payload struct {
			ChatID int64 `json:"chat_id"`
			Reply  struct {
				Rows [][]struct {
					App struct {
						URL string `json:"url"`
					} `json:"web_app"`
				} `json:"inline_keyboard"`
			} `json:"reply_markup"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload.ChatID != 42 || len(payload.Reply.Rows) != 1 || payload.Reply.Rows[0][0].App.URL != "https://example.test/app" {
			t.Error("wrong application entry")
		}
		io.WriteString(w, `{"ok":true,"result":{}}`)
	}))
	defer server.Close()
	bot, _ := New(fakeToken, "https://example.test/app")
	bot.baseURL = server.URL
	update := Update{Message: &Message{Text: "/start app"}}
	update.Message.Chat.ID = 42
	update.Message.Chat.Type = "private"
	if err := bot.Handle(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	update.Message.Text = "/help"
	if err := bot.Handle(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	update.Message.Text = "hello"
	bot.Handle(context.Background(), update)
	update.Message.Text = "/start"
	update.Message.Chat.Type = "group"
	bot.Handle(context.Background(), update)
	bot.Handle(context.Background(), Update{})
	if calls != 2 {
		t.Fatalf("unexpected replies: %d", calls)
	}
}
func TestConfiguresTheBotMenuForTheHTTPSApplication(t *testing.T) {
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		methods = append(methods, method)
		if method == "getMe" {
			io.WriteString(w, `{"ok":true,"result":{"username":"lumyboo_bot"}}`)
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		menu := body["menu_button"].(map[string]any)
		if menu["type"] != "web_app" || menu["web_app"].(map[string]any)["url"] != "https://example.test/app" {
			t.Error("invalid menu")
		}
		io.WriteString(w, `{"ok":true,"result":true}`)
	}))
	defer server.Close()
	bot, _ := New(fakeToken, "https://example.test/app")
	bot.baseURL = server.URL
	username, err := bot.Configure(context.Background())
	if err != nil || username != "lumyboo_bot" || strings.Join(methods, ",") != "getMe,setChatMenuButton" {
		t.Fatal("setup failed", err)
	}
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestDoesNotExposeTokenInTransportErrors(t *testing.T) {
	bot, _ := New(fakeToken, "https://example.test/app")
	bot.client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) { return nil, errors.New("failure at " + r.URL.String()) })}
	err := bot.call(context.Background(), "getMe", struct{}{}, nil)
	if err == nil || strings.Contains(err.Error(), fakeToken) || strings.Contains(err.Error(), "api.telegram.org") {
		t.Fatal("unsafe error")
	}
}
