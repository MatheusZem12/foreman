// Package hub distributes real-time events (over SSE) to whoever is looking at a
// workspace: an issue changed, a run moved on, a new log line arrived.
package hub

import (
	"encoding/json"
	"sync"
)

type Event struct {
	Type        string `json:"type"` // issue | issue_deleted | run | run_event | comment
	WorkspaceID string `json:"workspaceId"`
	Data        any    `json:"data"`
}

type Hub struct {
	mu   sync.Mutex
	subs map[chan []byte]string // canal → workspace ("" = todos)
}

func New() *Hub { return &Hub{subs: map[chan []byte]string{}} }

func (h *Hub) Subscribe(workspaceID string) chan []byte {
	ch := make(chan []byte, 256)
	h.mu.Lock()
	h.subs[ch] = workspaceID
	h.mu.Unlock()
	return ch
}

func (h *Hub) Unsubscribe(ch chan []byte) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *Hub) Publish(ev Event) {
	payload, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch, ws := range h.subs {
		if ws != "" && ws != ev.WorkspaceID {
			continue
		}
		select {
		case ch <- payload:
		default: // cliente lento: descarta em vez de travar o runner
		}
	}
}
