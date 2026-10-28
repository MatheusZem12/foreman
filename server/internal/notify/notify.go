// Package notify envia os avisos por e-mail. A configuração SMTP fica na
// tabela settings (o admin edita pela interface); nada vem do .env.
//
// Todo aviso de um workspace usa o mesmo assunto "[Multica] <workspace>" e
// referencia a mesma mensagem raiz, então o cliente de e-mail junta tudo
// numa conversa só por workspace em vez de criar um e-mail solto por issue.
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

	"multica/internal/store"
)

const settingsKey = "email"

// Destinatários por mensagem: servidores costumam limitar o RCPT (Gmail: 100).
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
	return Settings{Port: 587, Security: "starttls", FromName: "Multica"}
}

// Validate confere o mínimo para conseguir enviar.
func (c Settings) Validate() error {
	if strings.TrimSpace(c.Host) == "" {
		return errors.New("informe o servidor SMTP")
	}
	if c.Port <= 0 || c.Port > 65535 {
		return errors.New("porta inválida")
	}
	if _, err := mail.ParseAddress(c.From); err != nil {
		return errors.New("e-mail de envio inválido")
	}
	switch c.Security {
	case "starttls", "tls", "none":
	default:
		return errors.New("segurança deve ser starttls, tls ou none")
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

// IssueCreated avisa todo mundo do workspace, em segundo plano. Não faz nada
// se o admin não ligou as notificações. origin é a URL do Multica deduzida da
// requisição, usada nos links quando o admin não definiu uma.
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
		// No e-mail vai o nome da etapa como está no fluxo do workspace.
		shown := *is
		shown.Status = n.st.StageName(ctx, is.WorkspaceID, is.Status)
		is := &shown
		m := message{
			threadID: "ws-" + ws.ID,
			subject:  "[Multica] " + ws.Name,
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

var ErrDisabled = errors.New("o envio de e-mail está desligado (Servidor → E-mail)")

// StageEmail avisa as pessoas de uma mudança de etapa (regra "Notificar").
// Usa o mesmo assunto do workspace, para cair na mesma conversa.
func (n *Notifier) StageEmail(ctx context.Context, is *store.Issue, to []string, headline, note string) error {
	c, err := n.Settings(ctx)
	if err != nil {
		return err
	}
	if !c.Enabled {
		return ErrDisabled
	}
	if len(to) == 0 {
		return errors.New("ninguém para avisar")
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
		text += "\n\nAbrir: " + link
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
		fmt.Fprintf(&b, `<p style="margin-top:16px"><a href="%s" style="background:#5e6ad2;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none">Abrir issue</a></p>`, e(link))
	}
	b.WriteString(`</div>`)
	err = n.send(ctx, c, to, message{threadID: "ws-" + ws.ID, subject: "[Multica] " + ws.Name, text: text, html: b.String()})
	n.record(err)
	return err
}

// Test envia um e-mail de teste com a configuração informada (ainda não salva).
func (n *Notifier) Test(ctx context.Context, c Settings, to string) error {
	m := message{
		threadID: "teste",
		subject:  "[Multica] Teste de e-mail",
		text:     "Se você recebeu esta mensagem, o envio de e-mail do Multica está funcionando.",
		html:     `<p style="font-family:sans-serif">Se você recebeu esta mensagem, o envio de e-mail do Multica está funcionando.</p>`,
	}
	err := n.send(ctx, c, []string{to}, m)
	n.record(err)
	return err
}

// ---------- mensagem ----------

type message struct {
	threadID string
	subject  string
	text     string
	html     string
}

var priorityLabel = []string{"Sem prioridade", "Urgente", "Alta", "Média", "Baixa"}

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
	fmt.Fprintf(&b, "Nova issue em %s\n\n%s · %s\n", ws.Name, ref, is.Title)
	fmt.Fprintf(&b, "Criada por %s · %s · %s", author, is.Status, priority(is.Priority))
	if agent != "" {
		fmt.Fprintf(&b, " · agente %s", agent)
	}
	if d := excerpt(is.Description, 3000); d != "" {
		b.WriteString("\n\n" + d)
	}
	if base != "" {
		fmt.Fprintf(&b, "\n\nAbrir: %s/w/%s/issues/%s", base, ws.Key, ref)
		fmt.Fprintf(&b, "\n\nPara não receber mais, desligue em Minha conta: %s/w/%s/conta", base, ws.Key)
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
	meta := fmt.Sprintf("Criada por %s · %s · %s", e(author), e(is.Status), e(priority(is.Priority)))
	if agent != "" {
		meta += " · agente " + e(agent)
	}
	var b strings.Builder
	b.WriteString(`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#222;max-width:640px">`)
	fmt.Fprintf(&b, `<div style="color:#777;font-size:12px;margin-bottom:6px">Nova issue em %s</div>`, e(ws.Name))
	fmt.Fprintf(&b, `<div style="font-size:16px;font-weight:600;margin-bottom:4px">%s</div>`, title)
	fmt.Fprintf(&b, `<div style="color:#666;font-size:12px;margin-bottom:12px">%s</div>`, meta)
	if d := excerpt(is.Description, 3000); d != "" {
		fmt.Fprintf(&b, `<div style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:10px;color:#333">%s</div>`, e(d))
	}
	if link != "" {
		fmt.Fprintf(&b, `<p style="margin-top:16px"><a href="%s" style="background:#5e6ad2;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none">Abrir issue</a></p>`, e(link))
		fmt.Fprintf(&b, `<p style="color:#999;font-size:11px;margin-top:20px">Você recebe porque participa do workspace %s. Para parar, desligue em <a href="%s/w/%s/conta" style="color:#999">Minha conta</a>.</p>`, e(ws.Name), e(base), e(ws.Key))
	}
	b.WriteString(`</div>`)
	return b.String()
}

// build monta o MIME. Todas as mensagens de um thread apontam para a mesma
// raiz (In-Reply-To/References) e repetem o assunto: assim Gmail, Outlook e
// afins agrupam numa conversa só.
func build(c Settings, m message) []byte {
	domain := "multica.local"
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
	h("To", from) // destinatários vão só no envelope (cópia oculta)
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
		return fmt.Errorf("conectar em %s: %w", addr, err)
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
			return errors.New("o servidor não oferece STARTTLS; use TLS (porta 465) ou sem criptografia")
		}
		if err := cl.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("STARTTLS: %w", err)
		}
	}
	if c.Username != "" {
		if err := cl.Auth(smtp.PlainAuth("", c.Username, c.Password, c.Host)); err != nil {
			return fmt.Errorf("autenticação: %w", err)
		}
	}
	if err := cl.Mail(c.From); err != nil {
		return fmt.Errorf("remetente recusado: %w", err)
	}
	// Um endereço recusado não impede o envio para os demais.
	var refused []string
	for _, rcpt := range to {
		if err := cl.Rcpt(rcpt); err != nil {
			refused = append(refused, rcpt)
		}
	}
	if len(refused) == len(to) {
		return fmt.Errorf("destinatários recusados: %s", strings.Join(refused, ", "))
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
