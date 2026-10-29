// Package notify sends the e-mail notices. The SMTP configuration lives in the settings
// table (the admin edits it through the interface); nothing comes from .env.
//
// Every notice of a workspace uses the same subject "[Foreman] <workspace>" and
// references the same root message, so the mail client gathers everything into a
// single conversation per workspace instead of a loose e-mail per issue.
package notify

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"log"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"sync"
	"time"

	"foreman/internal/store"
)

const settingsKey = "email"

// Recipients per message: servers usually limit RCPT (Gmail: 100).
const batchSize = 50

type Settings struct {
	Enabled  bool   `json:"enabled"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Security string `json:"security"` // starttls | tls | none
	Username string `json:"username"`
	Password string `json:"password,omitempty"`
	From     string `json:"from"`
	FromName string `json:"fromName"`
	AppURL   string `json:"appUrl"`
}

func defaults() Settings {
	return Settings{Port: 587, Security: "starttls", FromName: "Foreman"}
}

// Validate checks the minimum needed to send.
func (c Settings) Validate() error {
	if strings.TrimSpace(c.Host) == "" {
		return errors.New("enter the SMTP server")
	}
	if c.Port <= 0 || c.Port > 65535 {
		return errors.New("invalid port")
	}
	if _, err := mail.ParseAddress(c.From); err != nil {
		return errors.New("invalid sender e-mail")
	}
	switch c.Security {
	case "starttls", "tls", "none":
	default:
		return errors.New("security must be starttls, tls or none")
	}
	return nil
}

type Status struct {
	LastSentAt *time.Time `json:"lastSentAt"`
	LastError  string     `json:"lastError"`
	LastErrAt  *time.Time `json:"lastErrorAt"`
}

type Notifier struct {
	st     *store.Store
	mu     sync.Mutex
	status Status
}

func New(st *store.Store) *Notifier { return &Notifier{st: st} }

func (n *Notifier) Settings(ctx context.Context) (Settings, error) {
	c := defaults()
	err := n.st.GetSetting(ctx, settingsKey, &c)
	return c, err
}

func (n *Notifier) Save(ctx context.Context, c Settings) error {
	return n.st.SetSetting(ctx, settingsKey, c)
}

func (n *Notifier) Status() Status {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.status
}

func (n *Notifier) record(err error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	now := time.Now()
	if err != nil {
		n.status.LastError, n.status.LastErrAt = err.Error(), &now
		log.Printf("e-mail: %v", err)
		return
	}
	n.status.LastSentAt = &now
}

// IssueCreated notifies everyone in the workspace, in the background. It does nothing
// if the admin didn't turn notifications on. origin is the Foreman URL inferred from
// the request, used in the links when the admin didn't set one.
func (n *Notifier) IssueCreated(is *store.Issue, author *store.User, origin string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		c, err := n.Settings(ctx)
		if err != nil || !c.Enabled {
			return
		}
		ws, err := n.st.Workspace(ctx, is.WorkspaceID)
		if err != nil {
			return
		}
		to, err := n.st.NotificationRecipients(ctx, is.WorkspaceID, author.ID)
		if err != nil || len(to) == 0 {
			return
		}
		agent := ""
		if is.AgentID != nil {
			if a, err := n.st.Agent(ctx, *is.AgentID); err == nil {
				agent = a.Name
			}
		}
		base := strings.TrimRight(c.AppURL, "/")
		if base == "" {
			base = origin
		}
		ref := fmt.Sprintf("%s-%d", ws.Key, is.Number)
		// The e-mail carries the stage name as it is in the workspace's workflow.
		shown := *is
		shown.Status = n.st.StageName(ctx, is.WorkspaceID, is.Status)
		is := &shown
		m := message{
			threadID: "ws-" + ws.ID,
			subject:  "[Foreman] " + ws.Name,
			text:     issueText(ws, is, ref, author.Name, agent, base),
			html:     issueHTML(ws, is, ref, author.Name, agent, base),
		}
		addrs := make([]string, len(to))
		for i, r := range to {
			addrs[i] = r.Email
		}
		n.record(n.send(ctx, c, addrs, m))
	}()
}

var ErrDisabled = errors.New("e-mail sending is turned off (Server → E-mail)")

// StageEmail tells people about a stage change (the "Notify" rule). It uses the
// workspace's subject, so it lands in the same conversation.
func (n *Notifier) StageEmail(ctx context.Context, is *store.Issue, to []string, headline, note string) error {
	c, err := n.Settings(ctx)
	if err != nil {
		return err
	}
	if !c.Enabled {
		return ErrDisabled
	}
	if len(to) == 0 {
		return errors.New("nobody to notify")
	}
	ws, err := n.st.Workspace(ctx, is.WorkspaceID)
	if err != nil {
		return err
	}
	ref := fmt.Sprintf("%s-%d", ws.Key, is.Number)
	base := strings.TrimRight(c.AppURL, "/")
	link := ""
	if base != "" {
		link = fmt.Sprintf("%s/w/%s/issues/%s", base, ws.Key, ref)
	}
	text := fmt.Sprintf("%s\n\n%s · %s", headline, ref, is.Title)
	if note != "" {
		text += "\n\n" + note
	}
	if link != "" {
		text += "\n\nOpen: " + link
	}
	e := html.EscapeString
	var b strings.Builder
	b.WriteString(`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#222;max-width:640px">`)
	fmt.Fprintf(&b, `<div style="color:#777;font-size:12px;margin-bottom:6px">%s</div>`, e(ws.Name))
	fmt.Fprintf(&b, `<div style="font-size:16px;font-weight:600;margin-bottom:8px">%s</div>`, e(headline))
	fmt.Fprintf(&b, `<div style="margin-bottom:12px">%s</div>`, e(ref+" · "+is.Title))
	if note != "" {
		fmt.Fprintf(&b, `<div style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:10px;color:#333">%s</div>`, e(note))
	}
	if link != "" {
		fmt.Fprintf(&b, `<p style="margin-top:16px"><a href="%s" style="background:#5e6ad2;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none">Open issue</a></p>`, e(link))
	}
	b.WriteString(`</div>`)
	err = n.send(ctx, c, to, message{threadID: "ws-" + ws.ID, subject: "[Foreman] " + ws.Name, text: text, html: b.String()})
	n.record(err)
	return err
}

// Test sends a test e-mail with the given configuration (not saved yet).
func (n *Notifier) Test(ctx context.Context, c Settings, to string) error {
	m := message{
		threadID: "test",
		subject:  "[Foreman] E-mail test",
		text:     "If you got this message, Foreman's e-mail sending works.",
		html:     `<p style="font-family:sans-serif">If you got this message, Foreman's e-mail sending works.</p>`,
	}
	err := n.send(ctx, c, []string{to}, m)
	n.record(err)
	return err
}

// ---------- message ----------

type message struct {
	threadID string
	subject  string
	text     string
	html     string
}

var priorityLabel = []string{"No priority", "Urgent", "High", "Medium", "Low"}

func priority(p int16) string {
	if p >= 0 && int(p) < len(priorityLabel) {
		return priorityLabel[p]
	}
	return ""
}

func excerpt(s string, max int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}

func issueText(ws *store.Workspace, is *store.Issue, ref, author, agent, base string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "New issue in %s\n\n%s · %s\n", ws.Name, ref, is.Title)
	fmt.Fprintf(&b, "Created by %s · %s · %s", author, is.Status, priority(is.Priority))
	if agent != "" {
		fmt.Fprintf(&b, " · agent %s", agent)
	}
	if d := excerpt(is.Description, 3000); d != "" {
		b.WriteString("\n\n" + d)
	}
	if base != "" {
		fmt.Fprintf(&b, "\n\nOpen: %s/w/%s/issues/%s", base, ws.Key, ref)
		fmt.Fprintf(&b, "\n\nTo stop receiving these, turn them off in My account: %s/w/%s/config/account", base, ws.Key)
	}
	return b.String()
}

func issueHTML(ws *store.Workspace, is *store.Issue, ref, author, agent, base string) string {
	e := html.EscapeString
	link := ""
	if base != "" {
		link = fmt.Sprintf("%s/w/%s/issues/%s", base, ws.Key, ref)
	}
	title := e(ref + " · " + is.Title)
	if link != "" {
		title = fmt.Sprintf(`<a href="%s" style="color:#5e6ad2;text-decoration:none">%s</a>`, e(link), title)
	}
	meta := fmt.Sprintf("Created by %s · %s · %s", e(author), e(is.Status), e(priority(is.Priority)))
	if agent != "" {
		meta += " · agent " + e(agent)
	}
	var b strings.Builder
	b.WriteString(`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#222;max-width:640px">`)
	fmt.Fprintf(&b, `<div style="color:#777;font-size:12px;margin-bottom:6px">New issue in %s</div>`, e(ws.Name))
	fmt.Fprintf(&b, `<div style="font-size:16px;font-weight:600;margin-bottom:4px">%s</div>`, title)
	fmt.Fprintf(&b, `<div style="color:#666;font-size:12px;margin-bottom:12px">%s</div>`, meta)
	if d := excerpt(is.Description, 3000); d != "" {
		fmt.Fprintf(&b, `<div style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:10px;color:#333">%s</div>`, e(d))
	}
	if link != "" {
		fmt.Fprintf(&b, `<p style="margin-top:16px"><a href="%s" style="background:#5e6ad2;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none">Open issue</a></p>`, e(link))
		fmt.Fprintf(&b, `<p style="color:#999;font-size:11px;margin-top:20px">You get this because you take part in the %s workspace. To stop, turn it off in <a href="%s/w/%s/config/account" style="color:#999">My account</a>.</p>`, e(ws.Name), e(base), e(ws.Key))
	}
	b.WriteString(`</div>`)
	return b.String()
}

// build assembles the MIME. Every message of a thread points to the same root
// (In-Reply-To/References) and repeats the subject: that way Gmail, Outlook and the
// like group them into a single conversation.
func build(c Settings, m message) []byte {
	domain := "foreman.local"
	if at := strings.LastIndex(c.From, "@"); at >= 0 {
		domain = c.From[at+1:]
	}
	id := make([]byte, 12)
	rand.Read(id)
	root := fmt.Sprintf("<%s@%s>", m.threadID, domain)
	from := (&mail.Address{Name: c.FromName, Address: c.From}).String()
	boundary := "mx-" + hex.EncodeToString(id)

	var b bytes.Buffer
	h := func(k, v string) { fmt.Fprintf(&b, "%s: %s\r\n", k, v) }
	h("From", from)
	h("To", from) // recipients go only in the envelope (blind copy)
	h("Subject", mime.QEncoding.Encode("utf-8", m.subject))
	h("Thread-Topic", mime.QEncoding.Encode("utf-8", m.subject))
	h("Date", time.Now().Format(time.RFC1123Z))
	h("Message-ID", fmt.Sprintf("<%s@%s>", hex.EncodeToString(id), domain))
	h("In-Reply-To", root)
	h("References", root)
	h("Auto-Submitted", "auto-generated")
	h("MIME-Version", "1.0")
	h("Content-Type", `multipart/alternative; boundary="`+boundary+`"`)
	b.WriteString("\r\n")
	part := func(ctype, body string) {
		fmt.Fprintf(&b, "--%s\r\nContent-Type: %s; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n", boundary, ctype)
		w := quotedprintable.NewWriter(&b)
		w.Write([]byte(body))
		w.Close()
		b.WriteString("\r\n")
	}
	part("text/plain", m.text)
	part("text/html", m.html)
	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return b.Bytes()
}

// ---------- SMTP ----------

func (n *Notifier) send(ctx context.Context, c Settings, to []string, m message) error {
	if err := c.Validate(); err != nil {
		return err
	}
	for start := 0; start < len(to); start += batchSize {
		end := min(start+batchSize, len(to))
		if err := deliver(ctx, c, to[start:end], build(c, m)); err != nil {
			return err
		}
	}
	return nil
}

func deliver(ctx context.Context, c Settings, to []string, msg []byte) error {
	addr := net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	d := net.Dialer{Timeout: 15 * time.Second}
	tlsCfg := &tls.Config{ServerName: c.Host}
	var conn net.Conn
	var err error
	if c.Security == "tls" {
		conn, err = (&tls.Dialer{NetDialer: &d, Config: tlsCfg}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("connect to %s: %w", addr, err)
	}
	conn.SetDeadline(time.Now().Add(time.Minute))
	cl, err := smtp.NewClient(conn, c.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("SMTP: %w", err)
	}
	defer cl.Close()
	if c.Security == "starttls" {
		if ok, _ := cl.Extension("STARTTLS"); !ok {
			return errors.New("the server doesn't offer STARTTLS; use TLS (port 465) or no encryption")
		}
		if err := cl.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("STARTTLS: %w", err)
		}
	}
	if c.Username != "" {
		if err := cl.Auth(smtp.PlainAuth("", c.Username, c.Password, c.Host)); err != nil {
			return fmt.Errorf("authentication: %w", err)
		}
	}
	if err := cl.Mail(c.From); err != nil {
		return fmt.Errorf("remetente recusado: %w", err)
	}
	// One refused address doesn't stop sending to the others.
	var refused []string
	for _, rcpt := range to {
		if err := cl.Rcpt(rcpt); err != nil {
			refused = append(refused, rcpt)
		}
	}
	if len(refused) == len(to) {
		return fmt.Errorf("recipients refused: %s", strings.Join(refused, ", "))
	}
	w, err := cl.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("envio: %w", err)
	}
	cl.Quit()
	if len(refused) > 0 {
		return fmt.Errorf("enviado, mas recusados: %s", strings.Join(refused, ", "))
	}
	return nil
}
