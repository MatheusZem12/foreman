package runner

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Entry is a normalized run-log line, the same for Claude, Codex and Gemini.
type Entry struct {
	Kind string // text | tool | out | error | info | result
	Body string
	// Only when Kind == "result":
	Final   string
	Cost    float64
	In      int64
	Cached  int64
	Out     int64
	IsError bool
}

var spaces = regexp.MustCompile(`\s+`)

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func describeInput(input map[string]any) string {
	for _, k := range []string{"command", "file_path", "path", "pattern", "url", "description", "prompt"} {
		if v, ok := input[k].(string); ok && v != "" {
			return clip(spaces.ReplaceAllString(v, " "), 160)
		}
	}
	b, _ := json.Marshal(input)
	return clip(string(b), 160)
}

type claudeEvent struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	Model     string `json:"model"`
	Message   struct {
		Content []struct {
			Type    string          `json:"type"`
			Text    string          `json:"text"`
			Name    string          `json:"name"`
			Input   map[string]any  `json:"input"`
			Content json.RawMessage `json:"content"`
			IsError bool            `json:"is_error"`
		} `json:"content"`
	} `json:"message"`
	Result       string   `json:"result"`
	IsError      bool     `json:"is_error"`
	TotalCostUSD *float64 `json:"total_cost_usd"`
	Usage        struct {
		InputTokens         int64 `json:"input_tokens"`
		CacheCreationTokens int64 `json:"cache_creation_input_tokens"`
		CacheReadTokens     int64 `json:"cache_read_input_tokens"`
		OutputTokens        int64 `json:"output_tokens"`
	} `json:"usage"`
}

func toolResultText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Text string `json:"text"`
	}
	json.Unmarshal(raw, &parts)
	var b strings.Builder
	for _, p := range parts {
		b.WriteString(p.Text)
	}
	return b.String()
}

func normalizeClaude(line []byte) []Entry {
	var ev claudeEvent
	if json.Unmarshal(line, &ev) != nil {
		return []Entry{{Kind: "out", Body: string(line)}}
	}
	var out []Entry
	switch {
	case ev.Type == "system" && ev.Subtype == "init":
		out = append(out, Entry{Kind: "info", Body: fmt.Sprintf("session %s · model %s", ev.SessionID, ev.Model)})
	case ev.Type == "assistant":
		for _, c := range ev.Message.Content {
			if c.Type == "text" && strings.TrimSpace(c.Text) != "" {
				out = append(out, Entry{Kind: "text", Body: c.Text})
			} else if c.Type == "tool_use" {
				out = append(out, Entry{Kind: "tool", Body: c.Name + "  " + describeInput(c.Input)})
			}
		}
	case ev.Type == "user":
		for _, c := range ev.Message.Content {
			if c.Type != "tool_result" {
				continue
			}
			if text := strings.TrimSpace(toolResultText(c.Content)); text != "" {
				kind := "out"
				if c.IsError {
					kind = "error"
				}
				out = append(out, Entry{Kind: kind, Body: clip(text, 600)})
			}
		}
	case ev.Type == "result" || ev.TotalCostUSD != nil:
		e := Entry{Kind: "result", Body: "Done", Final: ev.Result, IsError: ev.IsError,
			In: ev.Usage.InputTokens + ev.Usage.CacheCreationTokens, Cached: ev.Usage.CacheReadTokens, Out: ev.Usage.OutputTokens}
		if ev.TotalCostUSD != nil {
			e.Cost = *ev.TotalCostUSD
		}
		if ev.IsError {
			e.Body = "Failed: " + firstNonEmpty(ev.Result, ev.Subtype)
		}
		out = append(out, e)
	}
	return out
}

type codexEvent struct {
	Type     string `json:"type"`
	ThreadID string `json:"thread_id"`
	Message  string `json:"message"`
	Error    *struct {
		Message string `json:"message"`
	} `json:"error"`
	Item struct {
		Type             string `json:"type"`
		Text             string `json:"text"`
		Command          string `json:"command"`
		AggregatedOutput string `json:"aggregated_output"`
		ExitCode         *int   `json:"exit_code"`
		Message          string `json:"message"`
		Server           string `json:"server"`
		Tool             string `json:"tool"`
		Changes          []struct {
			Path string `json:"path"`
			Kind string `json:"kind"`
		} `json:"changes"`
	} `json:"item"`
	Usage struct {
		InputTokens       int64 `json:"input_tokens"`
		CachedInputTokens int64 `json:"cached_input_tokens"`
		OutputTokens      int64 `json:"output_tokens"`
	} `json:"usage"`
}

func normalizeCodex(line []byte) []Entry {
	var ev codexEvent
	if json.Unmarshal(line, &ev) != nil {
		return []Entry{{Kind: "out", Body: string(line)}}
	}
	it := ev.Item
	done := ev.Type == "item.completed"
	switch ev.Type {
	case "thread.started":
		return []Entry{{Kind: "info", Body: "thread " + ev.ThreadID}}
	case "item.started", "item.completed":
		switch it.Type {
		case "agent_message":
			if done {
				return []Entry{{Kind: "text", Body: it.Text}}
			}
		case "command_execution":
			if !done {
				return []Entry{{Kind: "tool", Body: "Bash  " + clip(it.Command, 160)}}
			}
			if it.AggregatedOutput != "" {
				kind := "out"
				if it.ExitCode != nil && *it.ExitCode != 0 {
					kind = "error"
				}
				return []Entry{{Kind: kind, Body: clip(it.AggregatedOutput, 600)}}
			}
		case "file_change":
			if done {
				var parts []string
				for _, c := range it.Changes {
					parts = append(parts, c.Kind+" "+c.Path)
				}
				return []Entry{{Kind: "tool", Body: "Edit  " + strings.Join(parts, ", ")}}
			}
		case "mcp_tool_call":
			if !done {
				return []Entry{{Kind: "tool", Body: it.Server + "." + it.Tool}}
			}
		case "error":
			return []Entry{{Kind: "error", Body: it.Message}}
		}
	case "turn.completed":
		return []Entry{{Kind: "result", Body: "Done",
			In: ev.Usage.InputTokens - ev.Usage.CachedInputTokens, Cached: ev.Usage.CachedInputTokens, Out: ev.Usage.OutputTokens}}
	case "turn.failed", "error":
		msg := ev.Message
		if ev.Error != nil {
			msg = ev.Error.Message
		}
		return []Entry{{Kind: "error", Body: msg}}
	}
	return nil
}

// Gemini CLI's stream-json: init, message (the assistant's text arrives in small deltas),
// tool_use, tool_result, error and a final result with the token counts.
type geminiEvent struct {
	Type       string         `json:"type"`
	SessionID  string         `json:"session_id"`
	Model      string         `json:"model"`
	Role       string         `json:"role"`
	Content    string         `json:"content"`
	Delta      bool           `json:"delta"`
	ToolName   string         `json:"tool_name"`
	Parameters map[string]any `json:"parameters"`
	Status     string         `json:"status"`
	Output     string         `json:"output"`
	Message    string         `json:"message"`
	Error      *struct {
		Message string `json:"message"`
	} `json:"error"`
	Stats struct {
		InputTokens  int64 `json:"input_tokens"`
		OutputTokens int64 `json:"output_tokens"`
		Cached       int64 `json:"cached"`
	} `json:"stats"`
}

// geminiParser joins the text deltas into one log line per message: it is written out
// when something else happens (a tool, the result) or the output ends.
type geminiParser struct {
	text strings.Builder
	all  strings.Builder // everything the assistant said, for the final result
}

func (p *geminiParser) flush() []Entry {
	t := strings.TrimSpace(p.text.String())
	p.text.Reset()
	if t == "" {
		return nil
	}
	return []Entry{{Kind: "text", Body: t}}
}

func (p *geminiParser) parse(line []byte) []Entry {
	var ev geminiEvent
	if json.Unmarshal(line, &ev) != nil {
		return append(p.flush(), Entry{Kind: "out", Body: string(line)})
	}
	switch ev.Type {
	case "init":
		return []Entry{{Kind: "info", Body: fmt.Sprintf("session %s · model %s", ev.SessionID, ev.Model)}}
	case "message":
		if ev.Role == "assistant" {
			if !ev.Delta {
				p.flush()
			}
			p.text.WriteString(ev.Content)
			p.all.WriteString(ev.Content)
			if !ev.Delta {
				return p.flush()
			}
		}
		return nil
	case "tool_use":
		return append(p.flush(), Entry{Kind: "tool", Body: ev.ToolName + "  " + describeInput(ev.Parameters)})
	case "tool_result":
		out := p.flush()
		if ev.Status == "error" {
			msg := ev.Output
			if ev.Error != nil {
				msg = firstNonEmpty(ev.Error.Message, msg)
			}
			return append(out, Entry{Kind: "error", Body: clip(strings.TrimSpace(msg), 600)})
		}
		if t := strings.TrimSpace(ev.Output); t != "" {
			out = append(out, Entry{Kind: "out", Body: clip(t, 600)})
		}
		return out
	case "error":
		return append(p.flush(), Entry{Kind: "error", Body: ev.Message})
	case "result":
		out := p.flush()
		e := Entry{Kind: "result", Body: "Done", Final: strings.TrimSpace(p.all.String()),
			In: ev.Stats.InputTokens - ev.Stats.Cached, Cached: ev.Stats.Cached, Out: ev.Stats.OutputTokens}
		if ev.Status == "error" {
			e.IsError = true
			e.Body = "Failed"
			if ev.Error != nil {
				e.Body = "Failed: " + ev.Error.Message
			}
		}
		return append(out, e)
	}
	return nil
}

// parserFor turns one line of a runtime's output into log entries. end is called when
// the output finishes (Gemini may still be holding the last piece of text).
func parserFor(runtime string) (parse func([]byte) []Entry, end func() []Entry) {
	switch runtime {
	case "codex":
		return normalizeCodex, func() []Entry { return nil }
	case "gemini":
		p := &geminiParser{}
		return p.parse, p.flush
	default:
		return normalizeClaude, func() []Entry { return nil }
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
