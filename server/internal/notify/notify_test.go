package notify

import (
	"strings"
	"testing"

	"foreman/internal/store"
)

func TestGmailFillsTheConnection(t *testing.T) {
	t.Setenv("FOREMAN_SMTP_CUSTOM", "")
	c := Settings{Host: "old.example.com", Port: 25, Security: "none", From: " team@gmail.com ", Password: "abcd efgh ijkl mnop"}.Gmail()
	if c.Host != "smtp.gmail.com" || c.Port != 587 || c.Security != "starttls" || c.Username != "team@gmail.com" {
		t.Fatalf("connection = %s:%d %s user %q", c.Host, c.Port, c.Security, c.Username)
	}
	if c.Password != "abcdefghijklmnop" || c.FromName != "Foreman" {
		t.Fatalf("password %q, name %q", c.Password, c.FromName)
	}
	if err := (Settings{From: "team@gmail.com"}).Gmail().Validate(); err == nil || !strings.Contains(err.Error(), "app password") {
		t.Fatalf("no app password should be refused, got %v", err)
	}
	if err := (Settings{From: "nope", Password: "x"}).Gmail().Validate(); err == nil {
		t.Fatal("an invalid address should be refused")
	}
}

func TestCustomSMTPKeepsTheFields(t *testing.T) {
	t.Setenv("FOREMAN_SMTP_CUSTOM", "1")
	c := Settings{Host: "mail", Port: 1025, Security: "none", From: "f@x.com"}.Gmail()
	if c.Host != "mail" || c.Port != 1025 || c.Username != "" || c.Validate() != nil {
		t.Fatalf("custom = %+v (%v)", c, c.Validate())
	}
}

// Gmail always sends as the account: the person shows in the name and gets the replies.
func TestSenderNameAndReplyTo(t *testing.T) {
	c := Settings{From: "team@gmail.com", FromName: "Foreman"}
	msg := string(build(c, message{threadID: "t", subject: "s", text: "x", html: "x", by: &store.User{Name: "Ana", Email: "ana@corp.com"}}))
	if !strings.Contains(msg, `From: "Ana via Foreman" <team@gmail.com>`) || !strings.Contains(msg, `Reply-To: "Ana" <ana@corp.com>`) {
		t.Fatalf("headers:\n%s", msg[:strings.Index(msg, "MIME-Version")])
	}
	sys := string(build(c, message{threadID: "t", subject: "s", text: "x", html: "x"}))
	if strings.Contains(sys, "\r\nReply-To:") || !strings.Contains(sys, `From: "Foreman" <team@gmail.com>`) {
		t.Fatalf("system e-mail headers:\n%s", sys[:strings.Index(sys, "MIME-Version")])
	}
}
