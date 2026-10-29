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

// Model catalog: built from the CLIs themselves, so the agent form only offers what
// exists and keeps up with releases without anyone typing anything.
//
//   - Codex: `codex debug models` returns the official catalog (Codex itself keeps it
//     up to date); without network, it falls back to its cache (~/.codex/models_cache.json).
//   - Claude: the aliases (opus, sonnet…) always point to the newest version and
//     come from `claude --help`; full names come from the Anthropic API when there is an
//     ANTHROPIC_API_KEY, or from the models already used on this machine.

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
	Efforts   []string      `json:"efforts"` // levels the CLI accepts
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

// Models returns the cached catalog; force queries the CLIs again.
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

// Refreshes the catalog on start and periodically, in the background.
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

// helpBlock cuts an option's text out of --help (up to the next option).
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
	"opus":   "The most capable; always the newest version",
	"sonnet": "A balance of quality, speed and cost; always the newest version",
	"haiku":  "The fastest and cheapest; always the newest version",
	"fable":  "Always the newest version of the Fable family",
}

func (r *Runner) claudeModels(ctx context.Context) RuntimeModels {
	out := RuntimeModels{Runtime: "claude", FetchedAt: time.Now(), Efforts: []string{"low", "medium", "high", "xhigh", "max"}}
	help := runCmd(ctx, r.cfg.ClaudeBin, "--help")
	out.Installed = help.ok
	if !help.ok {
		out.Error = "claude not found on the server"
		return out
	}
	text := help.stdout + "\n" + help.stderr

	// Aliases the CLI itself mentions + the classic aliases, which are still valid.
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
			desc = "Alias: always the newest version"
		}
		out.Models = append(out.Models, ModelOption{ID: a, Label: strings.ToUpper(a[:1]) + a[1:], Description: desc, Group: "alias"})
	}
	if m := reParens.FindStringSubmatch(helpBlock(text, "--effort <level>")); m != nil {
		out.Efforts = strings.Split(strings.ReplaceAll(m[1], " ", ""), ",")
	}
	out.Source = "claude --help"

	// Full names: the Anthropic API (with a key) or the ones already used on this machine.
	if full, err := anthropicModels(ctx); err == nil && len(full) > 0 {
		out.Models = append(out.Models, full...)
		out.Source += " + Anthropic API"
	} else if used := claudeUsedModels(); len(used) > 0 {
		out.Models = append(out.Models, used...)
		out.Source += " + local history"
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

// Models Claude Code has already used on this computer (its local statistics).
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
		out = append(out, ModelOption{ID: id, Label: id, Description: "Pinned version, already used on this computer", Group: "used"})
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
			out.Error = "codex not found on the server"
			return out
		}
		home := os.Getenv("CODEX_HOME")
		if home == "" {
			h, _ := os.UserHomeDir()
			home = filepath.Join(h, ".codex")
		}
		if b, err := os.ReadFile(filepath.Join(home, "models_cache.json")); err == nil && json.Unmarshal(b, &cat) == nil && len(cat.Models) > 0 {
			out.Source = "Codex cache"
		} else if b := runCmd(ctx, r.cfg.CodexBin, "debug", "models", "--bundled"); b.ok && json.Unmarshal([]byte(b.stdout), &cat) == nil {
			out.Source = "catalog built into Codex"
		} else {
			out.Error = "couldn't read the Codex catalog"
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
