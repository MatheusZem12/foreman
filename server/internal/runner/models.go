package runner

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Catálogo de modelos: montado a partir dos próprios CLIs, para o formulário do
// agente oferecer só o que existe e acompanhar lançamentos sem ninguém digitar nada.
//
//   - Codex: `codex debug models` devolve o catálogo oficial (o próprio Codex o
//     atualiza); sem rede, cai no cache dele (~/.codex/models_cache.json).
//   - Claude: os aliases (opus, sonnet…) sempre apontam para a versão mais nova e
//     vêm do `claude --help`; nomes completos vêm da API da Anthropic quando há
//     ANTHROPIC_API_KEY, ou dos modelos já usados nesta máquina.

type ModelOption struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Description   string   `json:"description,omitempty"`
	Group         string   `json:"group"` // alias | model | used
	Efforts       []string `json:"efforts,omitempty"`
	DefaultEffort string   `json:"defaultEffort,omitempty"`
}

type RuntimeModels struct {
	Runtime   string        `json:"runtime"`
	Installed bool          `json:"installed"`
	Models    []ModelOption `json:"models"`
	Efforts   []string      `json:"efforts"` // níveis aceitos pelo CLI
	Source    string        `json:"source"`
	FetchedAt time.Time     `json:"fetchedAt"`
	Error     string        `json:"error,omitempty"`
}

const modelsTTL = 6 * time.Hour

type modelCache struct {
	mu   sync.Mutex
	data []RuntimeModels
	at   time.Time
}

// Models devolve o catálogo em cache; force refaz a consulta aos CLIs.
func (r *Runner) Models(ctx context.Context, force bool) []RuntimeModels {
	r.models.mu.Lock()
	defer r.models.mu.Unlock()
	if !force && r.models.data != nil && time.Since(r.models.at) < modelsTTL {
		return r.models.data
	}
	r.models.data = []RuntimeModels{r.claudeModels(ctx), r.codexModels(ctx)}
	r.models.at = time.Now()
	return r.models.data
}

// Atualiza o catálogo ao subir e periodicamente, em segundo plano.
func (r *Runner) refreshModelsLoop(ctx context.Context) {
	r.Models(ctx, true)
	t := time.NewTicker(modelsTTL)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.Models(ctx, true)
		}
	}
}

var (
	reQuoted = regexp.MustCompile(`'([a-z][a-z0-9.\[\]-]*)'`)
	reParens = regexp.MustCompile(`\(([a-z]+(?:,\s*[a-z]+)+)\)`)
)

// helpBlock recorta o texto de uma opção no --help (até a próxima opção).
func helpBlock(help, flag string) string {
	i := strings.Index(help, flag)
	if i < 0 {
		return ""
	}
	rest := help[i+len(flag):]
	if j := strings.Index(rest, "\n  -"); j >= 0 {
		rest = rest[:j]
	}
	return strings.Join(strings.Fields(rest), " ")
}

var claudeAliasInfo = map[string]string{
	"opus":   "O mais capaz; sempre a versão mais nova",
	"sonnet": "Equilíbrio entre qualidade, velocidade e custo; sempre a versão mais nova",
	"haiku":  "O mais rápido e barato; sempre a versão mais nova",
	"fable":  "Sempre a versão mais nova da família Fable",
}

func (r *Runner) claudeModels(ctx context.Context) RuntimeModels {
	out := RuntimeModels{Runtime: "claude", FetchedAt: time.Now(), Efforts: []string{"low", "medium", "high", "xhigh", "max"}}
	help := runCmd(ctx, r.cfg.ClaudeBin, "--help")
	out.Installed = help.ok
	if !help.ok {
		out.Error = "claude não encontrado no servidor"
		return out
	}
	text := help.stdout + "\n" + help.stderr

	// Aliases citados pelo próprio CLI + os aliases clássicos, que continuam válidos.
	aliases := []string{}
	seen := map[string]bool{}
	for _, m := range reQuoted.FindAllStringSubmatch(helpBlock(text, "--model <model>"), -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			aliases = append(aliases, m[1])
		}
	}
	for _, a := range []string{"opus", "sonnet", "haiku"} {
		if !seen[a] {
			seen[a] = true
			aliases = append(aliases, a)
		}
	}
	for _, a := range aliases {
		desc := claudeAliasInfo[a]
		if desc == "" {
			desc = "Alias: sempre a versão mais nova"
		}
		out.Models = append(out.Models, ModelOption{ID: a, Label: strings.ToUpper(a[:1]) + a[1:], Description: desc, Group: "alias"})
	}
	if m := reParens.FindStringSubmatch(helpBlock(text, "--effort <level>")); m != nil {
		out.Efforts = strings.Split(strings.ReplaceAll(m[1], " ", ""), ",")
	}
	out.Source = "claude --help"

	// Nomes completos: API da Anthropic (com chave) ou os já usados nesta máquina.
	if full, err := anthropicModels(ctx); err == nil && len(full) > 0 {
		out.Models = append(out.Models, full...)
		out.Source += " + API da Anthropic"
	} else if used := claudeUsedModels(); len(used) > 0 {
		out.Models = append(out.Models, used...)
		out.Source += " + histórico local"
	}
	return out
}

func anthropicModels(ctx context.Context) ([]ModelOption, error) {
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.anthropic.com/v1/models?limit=100", nil)
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", "2023-06-01")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var body struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	var out []ModelOption
	for _, m := range body.Data {
		out = append(out, ModelOption{ID: m.ID, Label: firstNonEmpty(m.DisplayName, m.ID), Group: "model"})
	}
	return out, nil
}

// Modelos que o Claude Code já usou neste computador (estatísticas locais dele).
func claudeUsedModels() []ModelOption {
	home, _ := os.UserHomeDir()
	b, err := os.ReadFile(filepath.Join(home, ".claude", "stats-cache.json"))
	if err != nil {
		return nil
	}
	var stats struct {
		ModelUsage map[string]json.RawMessage `json:"modelUsage"`
	}
	if json.Unmarshal(b, &stats) != nil {
		return nil
	}
	ids := []string{}
	for id := range stats.ModelUsage {
		if strings.HasPrefix(id, "claude-") {
			ids = append(ids, id)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ids)))
	var out []ModelOption
	for _, id := range ids {
		out = append(out, ModelOption{ID: id, Label: id, Description: "Versão fixa, já usada neste computador", Group: "used"})
	}
	return out
}

type codexCatalog struct {
	Models []struct {
		Slug          string `json:"slug"`
		DisplayName   string `json:"display_name"`
		Description   string `json:"description"`
		Visibility    string `json:"visibility"`
		Priority      int    `json:"priority"`
		DefaultEffort string `json:"default_reasoning_level"`
		Levels        []struct {
			Effort string `json:"effort"`
		} `json:"supported_reasoning_levels"`
	} `json:"models"`
}

func (r *Runner) codexModels(ctx context.Context) RuntimeModels {
	out := RuntimeModels{Runtime: "codex", FetchedAt: time.Now()}
	var cat codexCatalog
	res := runCmd(ctx, r.cfg.CodexBin, "debug", "models")
	switch {
	case res.ok && json.Unmarshal([]byte(res.stdout), &cat) == nil && len(cat.Models) > 0:
		out.Installed, out.Source = true, "codex debug models"
	default:
		out.Installed = runCmd(ctx, r.cfg.CodexBin, "--version").ok
		if !out.Installed {
			out.Error = "codex não encontrado no servidor"
			return out
		}
		home := os.Getenv("CODEX_HOME")
		if home == "" {
			h, _ := os.UserHomeDir()
			home = filepath.Join(h, ".codex")
		}
		if b, err := os.ReadFile(filepath.Join(home, "models_cache.json")); err == nil && json.Unmarshal(b, &cat) == nil && len(cat.Models) > 0 {
			out.Source = "cache do Codex"
		} else if b := runCmd(ctx, r.cfg.CodexBin, "debug", "models", "--bundled"); b.ok && json.Unmarshal([]byte(b.stdout), &cat) == nil {
			out.Source = "catálogo embutido no Codex"
		} else {
			out.Error = "não foi possível ler o catálogo do Codex"
			return out
		}
	}
	sort.SliceStable(cat.Models, func(i, j int) bool { return cat.Models[i].Priority < cat.Models[j].Priority })
	seen := map[string]bool{}
	for _, m := range cat.Models {
		if m.Visibility == "hide" {
			continue
		}
		o := ModelOption{ID: m.Slug, Label: firstNonEmpty(m.DisplayName, m.Slug), Description: m.Description, Group: "model", DefaultEffort: m.DefaultEffort}
		for _, l := range m.Levels {
			o.Efforts = append(o.Efforts, l.Effort)
			if !seen[l.Effort] {
				seen[l.Effort] = true
				out.Efforts = append(out.Efforts, l.Effort)
			}
		}
		out.Models = append(out.Models, o)
	}
	return out
}
