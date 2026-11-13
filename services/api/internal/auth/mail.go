package auth

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/netip"
	"net/smtp"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type SMTPConfig struct {
	Address, From, Username, Password string
	AllowInsecure                     bool
}
type Config struct {
	Origin         string
	Secret         []byte
	SecureCookies  bool
	SMTP           SMTPConfig
	TrustedProxies []netip.Prefix
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
func LoadConfig(get func(string) string) (*Config, error) {
	if get("AUTH_SECRET") == "" {
		return nil, nil
	}
	secret, err := base64.StdEncoding.DecodeString(get("AUTH_SECRET"))
	if err != nil || len(secret) < 32 {
		return nil, errors.New("AUTH_SECRET must be base64 with at least 32 decoded bytes")
	}
	origin := strings.TrimSuffix(get("PUBLIC_ORIGIN"), "/")
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("PUBLIC_ORIGIN must be an origin without a path")
	}
	development := get("APP_ENV") == "development"
	secure := u.Scheme == "https"
	if !secure && !(development && u.Scheme == "http" && loopback(u.Hostname())) {
		return nil, errors.New("authentication requires HTTPS; HTTP is permitted only for loopback development")
	}
	host, port, err := net.SplitHostPort(get("SMTP_ADDRESS"))
	if err != nil || host == "" {
		return nil, errors.New("SMTP_ADDRESS must include host and port")
	}
	if n, e := strconv.Atoi(port); e != nil || n < 1 || n > 65535 {
		return nil, errors.New("invalid SMTP port")
	}
	from, err := mail.ParseAddress(get("SMTP_FROM"))
	if err != nil || from.Address != get("SMTP_FROM") || strings.ContainsAny(get("SMTP_FROM"), "\r\n") {
		return nil, errors.New("SMTP_FROM must be a plain email address")
	}
	allowInsecure := get("SMTP_ALLOW_INSECURE") == "true"
	if allowInsecure && !(development && loopback(host)) {
		return nil, errors.New("plaintext SMTP is permitted only for loopback development")
	}
	var proxies []netip.Prefix
	for _, entry := range strings.Split(get("TRUSTED_PROXY_CIDRS"), ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			prefix, err := netip.ParsePrefix(entry)
			if err != nil {
				return nil, errors.New("invalid TRUSTED_PROXY_CIDRS")
			}
			proxies = append(proxies, prefix)
		}
	}
	return &Config{Origin: origin, Secret: secret, SecureCookies: secure, TrustedProxies: proxies, SMTP: SMTPConfig{Address: get("SMTP_ADDRESS"), From: from.Address, Username: get("SMTP_USERNAME"), Password: get("SMTP_PASSWORD"), AllowInsecure: allowInsecure}}, nil
}

type SMTPMailer struct{ Config SMTPConfig }

func (m SMTPMailer) SendCode(ctx context.Context, to, code string, ttl time.Duration) error {
	host, _, err := net.SplitHostPort(m.Config.Address)
	if err != nil {
		return err
	}
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", m.Config.Address)
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer client.Close()
	if !m.Config.AllowInsecure {
		if err = client.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err != nil {
			return err
		}
	}
	if m.Config.Username != "" {
		if err = client.Auth(smtp.PlainAuth("", m.Config.Username, m.Config.Password, host)); err != nil {
			return err
		}
	}
	if err = client.Mail(m.Config.From); err != nil {
		return err
	}
	if err = client.Rcpt(to); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	body := fmt.Sprintf("Код входа в Lumyboo: %s\n\nКод действует %d минут. Не сообщай его другим. Если ты не запрашивал вход, просто проигнорируй письмо.\n", code, int(ttl.Minutes()))
	message := "From: " + m.Config.From + "\r\nTo: " + to + "\r\nSubject: " + mime.QEncoding.Encode("utf-8", "Код входа в Lumyboo") + "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + base64.StdEncoding.EncodeToString([]byte(body)) + "\r\n"
	if _, err = writer.Write([]byte(message)); err != nil {
		return err
	}
	if err = writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}
