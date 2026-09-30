package ws

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type env struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// testServer upgrades every connection and forwards received envelope types.
// closeFirst makes it drop the first connection right after the hello.
func testServer(t *testing.T, closeFirst bool) (*httptest.Server, <-chan string) {
	t.Helper()
	got := make(chan string, 100)
	var conns atomic.Int32
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		first := conns.Add(1) == 1
		for {
			_, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			var e env
			_ = json.Unmarshal(msg, &e)
			got <- e.Type
			if first && closeFirst && e.Type == "hello" {
				c.Close()
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

func wsURL(s *httptest.Server) string { return "ws" + strings.TrimPrefix(s.URL, "http") }

func expectTypes(t *testing.T, got <-chan string, want ...string) {
	t.Helper()
	for _, w := range want {
		select {
		case g := <-got:
			if g != w {
				t.Fatalf("got %q, want %q", g, w)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for %q", w)
		}
	}
}

func TestSendQueuesWhileDisconnected(t *testing.T) {
	srv, got := testServer(t, false)
	c := NewClient(wsURL(srv), "tok", func(string, json.RawMessage) {})
	// Sent before the connection exists — previously dropped with "not connected".
	if err := c.Send("game_started", map[string]string{"matchId": "111"}); err != nil {
		t.Fatal(err)
	}
	go c.Run()
	defer c.Close()
	expectTypes(t, got, "hello", "game_started")
}

func TestReconnectResumesDelivery(t *testing.T) {
	srv, got := testServer(t, true)
	c := NewClient(wsURL(srv), "tok", func(string, json.RawMessage) {})
	go c.Run()
	defer c.Close()
	expectTypes(t, got, "hello") // first connection, server closes it
	_ = c.Send("lobby_status", map[string]string{"lobbyId": "1"})
	expectTypes(t, got, "hello", "lobby_status") // delivered on the second connection
}

func TestSendOrderPreserved(t *testing.T) {
	srv, got := testServer(t, false)
	c := NewClient(wsURL(srv), "", func(string, json.RawMessage) {})
	go c.Run()
	defer c.Close()
	c.WaitConnected()
	for _, typ := range []string{"a", "b", "c"} {
		_ = c.Send(typ, nil)
	}
	expectTypes(t, got, "hello", "a", "b", "c")
}
