package ws

import (
	"encoding/json"
	"fmt"
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

// seqTestServer is like testServer but its close decision is a callback over
// (connection index, message type) instead of a single "first connection,
// after hello" rule — used to force a connection to die at an exact point in
// a multi-message exchange (e.g. mid carry-flush).
func seqTestServer(t *testing.T, closeAfter func(connIdx int, msgType string) bool) (*httptest.Server, <-chan string) {
	t.Helper()
	got := make(chan string, 100)
	var conns atomic.Int32
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		idx := int(conns.Add(1)) - 1
		for {
			_, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			var e env
			_ = json.Unmarshal(msg, &e)
			got <- e.Type
			if closeAfter(idx, e.Type) {
				c.Close()
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

// pongControlledServer is like testServer but gives the test explicit,
// deterministic control over the client's heartbeat: onPing is invoked for
// every Ping frame the server receives (bypassing gorilla's default
// auto-reply), and returns whether to answer with a Pong (echoing the same
// payload — Node's `ws` does this automatically in production) and whether
// to close the connection right after handling it.
func pongControlledServer(t *testing.T, onPing func(connIdx int, payload string) (ack, closeConn bool)) (*httptest.Server, <-chan string) {
	t.Helper()
	got := make(chan string, 100)
	var conns atomic.Int32
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		idx := int(conns.Add(1)) - 1
		c.SetPingHandler(func(payload string) error {
			ack, closeConn := onPing(idx, payload)
			if ack {
				if err := c.WriteControl(websocket.PongMessage, []byte(payload), time.Now().Add(writeWait)); err != nil {
					return err
				}
			}
			if closeConn {
				c.Close()
			}
			return nil
		})
		for {
			_, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			var e env
			_ = json.Unmarshal(msg, &e)
			got <- e.Type
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

// TestAckedMessageNotResent pins down the "confirm" half of the resend
// contract: once a message's write is vouched for by a pong sequence ack,
// it must not be resent after a later reconnect, even though the connection
// it was acked on then dies.
func TestAckedMessageNotResent(t *testing.T) {
	var ready atomic.Bool // set once the server has actually read acked_msg
	srv, got := pongControlledServer(t, func(connIdx int, payload string) (ack, closeConn bool) {
		if connIdx != 0 || !ready.Load() {
			// Ignore any ping that might race ahead of Send — acking (or
			// closing on) one of these could confirm nothing (acked_msg
			// not written yet) or tear the connection down before it's
			// even sent, which isn't what this test is about.
			return false, false
		}
		// Ack this ping, then die right after — that ack is the sole proof
		// acked_msg (written before it, per the ready gate above) was
		// delivered.
		return true, true
	})
	c := NewClient(wsURL(srv), "tok", func(string, json.RawMessage) {})
	c.pingPeriod = 20 * time.Millisecond
	go c.Run()
	defer c.Close()
	c.WaitConnected()
	if err := c.Send("acked_msg", nil); err != nil {
		t.Fatal(err)
	}
	expectTypes(t, got, "hello", "acked_msg") // proof the server — and so the client's own write — already happened
	ready.Store(true)
	// conn2: acked_msg was confirmed on conn1, so it must not reappear.
	expectTypes(t, got, "hello")
	select {
	case typ := <-got:
		t.Fatalf("acked message was resent after reconnect: %q", typ)
	case <-time.After(200 * time.Millisecond):
	}
}

// TestUnackedMessageResent is the mirror of TestAckedMessageNotResent: a
// message whose ping never gets acked (Node/the peer never answers) must
// still be resent after reconnect — the default, safe assumption.
func TestUnackedMessageResent(t *testing.T) {
	var ready atomic.Bool // set once the server has actually read unacked_msg
	srv, got := pongControlledServer(t, func(connIdx int, payload string) (ack, closeConn bool) {
		if connIdx != 0 || !ready.Load() {
			return false, false // ignore pings that might race ahead of Send
		}
		// Never ack — die right after the first ping once the message is
		// definitely written.
		return false, true
	})
	c := NewClient(wsURL(srv), "tok", func(string, json.RawMessage) {})
	c.pingPeriod = 20 * time.Millisecond
	go c.Run()
	defer c.Close()
	c.WaitConnected()
	if err := c.Send("unacked_msg", nil); err != nil {
		t.Fatal(err)
	}
	expectTypes(t, got, "hello", "unacked_msg")
	ready.Store(true)
	expectTypes(t, got, "hello", "unacked_msg") // resent on conn2 — never acked
}

// closedConn dials a real WS server and immediately closes the client side,
// giving tests a *websocket.Conn whose WriteMessage deterministically fails
// — no network race, since closing a socket makes every subsequent local
// write on it error out immediately, every time.
func closedConn(t *testing.T) *websocket.Conn {
	t.Helper()
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	conn, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return conn
}

// TestFlushWaitsForOutboxDrain proves Flush's shutdown contract: every
// message queued via Send before the call has reached the peer by the time
// Flush returns, well inside its budget — not just been buffered locally.
// This is what main.go relies on between DisconnectAll and Close so Node
// sees each bot's final "offline" status instead of racing the connection
// teardown.
func TestFlushWaitsForOutboxDrain(t *testing.T) {
	srv, got := testServer(t, false)
	c := NewClient(wsURL(srv), "", func(string, json.RawMessage) {})
	go c.Run()
	defer c.Close()
	c.WaitConnected()
	expectTypes(t, got, "hello")

	const n = 20
	for i := 0; i < n; i++ {
		if err := c.Send(fmt.Sprintf("m%d", i), nil); err != nil {
			t.Fatal(err)
		}
	}
	c.Flush(3 * time.Second)

	for i := 0; i < n; i++ {
		want := fmt.Sprintf("m%d", i)
		select {
		case typ := <-got:
			if typ != want {
				t.Fatalf("message %d = %q, want %q", i, typ, want)
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatalf("message %d (%q) not received by the server after Flush returned", i, want)
		}
	}
}

// TestPartialCarryFlushOnWriteFailureKeepsTail calls writeLoop directly
// (bypassing the network entirely) with a carry of 3 messages and a
// connection whose first write is guaranteed to fail. This is the
// deterministic regression test for the "partial carry flush loses the
// tail" bug: the pre-fix code only ever carried `unconfirmed` (just the
// message that failed) forward, silently dropping every message after it
// that the flush loop hadn't gotten to yet.
func TestPartialCarryFlushOnWriteFailureKeepsTail(t *testing.T) {
	c := NewClient("ws://unused", "", func(string, json.RawMessage) {})
	m1, _ := marshalEnvelope("m1", nil)
	m2, _ := marshalEnvelope("m2", nil)
	m3, _ := marshalEnvelope("m3", nil)
	c.carry = [][]byte{m1, m2, m3}

	conn := closedConn(t)
	stop := make(chan struct{})
	done := make(chan struct{})
	ackCh := make(chan uint64)
	c.writeLoop(conn, stop, done, ackCh) // returns as soon as the first write fails
	<-done

	assertCarry(t, c.carry, m1, m2, m3)
}

// TestPartialCarryFlushOnStopKeepsTail covers the other early-exit path in
// the same flush loop: the reader tearing the connection down (closing stop)
// before the writer even attempts the next message. Every message not yet
// attempted — the whole msgs[i:] slice, not just msgs[i+1:] — must survive.
func TestPartialCarryFlushOnStopKeepsTail(t *testing.T) {
	c := NewClient("ws://unused", "", func(string, json.RawMessage) {})
	m1, _ := marshalEnvelope("m1", nil)
	m2, _ := marshalEnvelope("m2", nil)
	m3, _ := marshalEnvelope("m3", nil)
	c.carry = [][]byte{m1, m2, m3}

	conn := closedConn(t) // never actually written to: stop fires before any write is attempted
	stop := make(chan struct{})
	close(stop) // pre-closed, so the flush loop's very first stop-check fires
	done := make(chan struct{})
	ackCh := make(chan uint64)
	c.writeLoop(conn, stop, done, ackCh)
	<-done

	assertCarry(t, c.carry, m1, m2, m3)
}

func assertCarry(t *testing.T, got [][]byte, want ...[]byte) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("carry = %d message(s), want %d", len(got), len(want))
	}
	for i := range want {
		if string(got[i]) != string(want[i]) {
			t.Fatalf("carry[%d] = %s, want %s", i, got[i], want[i])
		}
	}
}

// TestPartialCarryFlushKeepsTail is an end-to-end companion to the two
// deterministic unit tests above: it exercises the same "partial flush"
// scenario over a real reconnect sequence (server closes mid carry-flush),
// verifying the fix holds up through connect()/writeLoop() wiring too, not
// just the flush loop in isolation.
func TestPartialCarryFlushKeepsTail(t *testing.T) {
	srv, got := seqTestServer(t, func(connIdx int, typ string) bool {
		switch {
		case connIdx == 0 && typ == "m2":
			return true // conn1 dies right after m1 and m2 are both read — neither gets acked in time
		case connIdx == 1 && typ == "m1":
			return true // conn2 dies mid carry-flush, right after resending m1 — m2 must not be lost
		default:
			return false
		}
	})
	c := NewClient(wsURL(srv), "tok", func(string, json.RawMessage) {})
	go c.Run()
	defer c.Close()
	c.WaitConnected()
	if err := c.Send("m1", nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Send("m2", nil); err != nil {
		t.Fatal(err)
	}
	expectTypes(t, got, "hello", "m1", "m2") // conn1: both delivered, connection dies before either is acked
	expectTypes(t, got, "hello", "m1")       // conn2: carry-flush resends m1, then dies before m2 is attempted
	expectTypes(t, got, "hello", "m1", "m2") // conn3: nothing lost — m2 survives the interrupted flush
}
