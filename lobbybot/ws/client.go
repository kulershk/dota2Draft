package ws

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// outboxSize bounds memory while Node is down (a deploy is ~30s; a busy
	// lobby emits a few messages per second). The live outbox (queued via
	// Send) drops the newest message on overflow, since Send must never
	// block. The carried-forward resend list (writes that survived a dead
	// connection unconfirmed, see the carry doc comment) is bounded the same
	// way but drops the oldest messages instead — during a long outage the
	// most recent state matters more than an ever-growing backlog. Both
	// count into `dropped`.
	outboxSize = 2048
	writeWait  = 10 * time.Second // a single write may not block longer than this
	pongWait   = 60 * time.Second // no pong/message for this long = dead link
)

// defaultPingPeriod drives both the heartbeat and, via the pong's echoed
// sequence number, delivery confirmation (see writeLoop). Must stay well
// under pongWait. It's copied into Client.pingPeriod so tests in this
// package can shrink it to get deterministic ack timing without waiting out
// a real 20s cycle.
const defaultPingPeriod = 20 * time.Second

type Client struct {
	url     string
	token   string
	handler func(msgType string, data json.RawMessage)

	// outbox holds marshalled envelopes. Send enqueues; exactly one writer
	// goroutine (per live connection) dequeues — gorilla/websocket allows only
	// one concurrent writer, and a stalled write can no longer hold a mutex
	// that every bot's setStatus/log needs.
	outbox chan []byte
	// carry holds messages a previous connection sent but could not prove
	// were delivered; the next connection's writer resends them first, in
	// order. Only touched by writers, which never overlap (connect() waits
	// on writerDone before starting the next one).
	//
	// A successful WriteMessage is not proof of delivery: a local write can
	// still succeed into the kernel send buffer after the peer has already
	// torn down the socket (the resulting RST arrives asynchronously). Proof
	// only exists at the transport level in one form: gorilla/ws (and
	// Node's `ws`) auto-answer a Ping with a Pong that echoes the same
	// payload. Each connection's writer tags every Ping it sends with an
	// increasing sequence number and remembers how many bytes had been
	// written when it sent that Ping; when the matching Pong comes back, TCP's
	// in-order, reliable-per-direction delivery guarantees everything written
	// before that Ping actually reached the peer, so that prefix is dropped
	// from the resend list. (An unrelated inbound *message* from the server
	// proves nothing about earlier writes — the two directions of a TCP
	// connection are ordered independently — so only pong sequence numbers
	// count as confirmation.) Whatever is still unconfirmed when a
	// connection dies — whether a write errored or not, and including any
	// messages this same writer never got the chance to attempt — is
	// carried forward.
	carry   [][]byte
	dropped atomic.Uint64

	pingPeriod time.Duration

	mu          sync.Mutex
	conn        *websocket.Conn
	done        chan struct{}
	closeOnce   sync.Once
	connectedCh chan struct{}
	connOnce    sync.Once

	// OnConnect, if set, runs after every successful (re)connect.
	OnConnect func()
}

func NewClient(wsURL, token string, handler func(string, json.RawMessage)) *Client {
	return &Client{
		url:         wsURL,
		token:       token,
		handler:     handler,
		outbox:      make(chan []byte, outboxSize),
		pingPeriod:  defaultPingPeriod,
		done:        make(chan struct{}),
		connectedCh: make(chan struct{}),
	}
}

func marshalEnvelope(msgType string, data interface{}) ([]byte, error) {
	dataBytes, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}{msgType, dataBytes})
}

// WaitConnected blocks until the first successful WS connection.
func (c *Client) WaitConnected() { <-c.connectedCh }

// Send queues a message for delivery. It never blocks and never drops because
// the link is down — queued messages flush in order on the next connection.
func (c *Client) Send(msgType string, data interface{}) error {
	b, err := marshalEnvelope(msgType, data)
	if err != nil {
		return err
	}
	select {
	case c.outbox <- b:
		return nil
	default:
		n := c.dropped.Add(1)
		log.Printf("WS outbox full — dropped %s (total dropped: %d)", msgType, n)
		return fmt.Errorf("outbox full")
	}
}

func (c *Client) Run() {
	attempt := 0
	for {
		select {
		case <-c.done:
			return
		default:
		}
		established, err := c.connect()
		if err != nil {
			log.Printf("WS connection error: %v", err)
		}
		if established {
			attempt = 0
		}
		delaySec := math.Min(math.Pow(2, float64(attempt)), 15)
		attempt++
		delay := time.Duration(delaySec) * time.Second
		log.Printf("Reconnecting in %v...", delay)
		select {
		case <-c.done:
			return
		case <-time.After(delay):
		}
	}
}

func (c *Client) connect() (bool, error) {
	u, err := url.Parse(c.url)
	if err != nil {
		return false, fmt.Errorf("invalid URL: %w", err)
	}
	if c.token != "" {
		q := u.Query()
		q.Set("token", c.token)
		u.RawQuery = q.Encode()
	}
	log.Printf("Connecting to %s", c.url)
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		return false, fmt.Errorf("dial failed: %w", err)
	}

	// ackCh carries the sequence number echoed back by each Pong, decoded by
	// the pong handler below (invoked on the read goroutine) and consumed by
	// this connection's writer goroutine. It's created fresh per connection
	// so a stale signal from a previous (dead) connection can never leak
	// into this one's confirmation bookkeeping.
	ackCh := make(chan uint64, 1)
	setAck := func(seq uint64) {
		select {
		case ackCh <- seq:
		default:
			select {
			case <-ackCh:
			default:
			}
			ackCh <- seq
		}
	}

	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(appData string) error {
		if seq, err := strconv.ParseUint(appData, 10, 64); err == nil {
			setAck(seq)
		}
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	// hello goes first, directly, so Node's sync runs before queued events.
	hello, _ := marshalEnvelope("hello", map[string]string{"version": "1.1"})
	conn.SetWriteDeadline(time.Now().Add(writeWait))
	if err := conn.WriteMessage(websocket.TextMessage, hello); err != nil {
		conn.Close()
		return true, fmt.Errorf("hello failed: %w", err)
	}

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
	log.Println("WS connected")
	c.connOnce.Do(func() { close(c.connectedCh) })

	stop := make(chan struct{})
	writerDone := make(chan struct{})
	go c.writeLoop(conn, stop, writerDone, ackCh)
	if c.OnConnect != nil {
		go c.OnConnect()
	}

	err = c.readLoop(conn)

	close(stop)
	conn.Close()
	<-writerDone
	c.mu.Lock()
	c.conn = nil
	c.mu.Unlock()
	return true, err
}

func (c *Client) readLoop(conn *websocket.Conn) error {
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("WS read error: %v", err)
			return err
		}
		conn.SetReadDeadline(time.Now().Add(pongWait))
		var env struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(message, &env); err != nil {
			log.Printf("Invalid message: %v", err)
			continue
		}
		c.dispatch(env.Type, env.Data)
	}
}

// dispatch runs the command handler; a panic in one command must not kill the
// read loop (and with it every bot's link to Node).
func (c *Client) dispatch(msgType string, data json.RawMessage) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("PANIC handling %s: %v", msgType, r)
		}
	}()
	if c.handler != nil {
		c.handler(msgType, data)
	}
}

// capCarry bounds the resend list the same way outbox is bounded (see the
// outboxSize doc comment), dropping the oldest entries on overflow.
func (c *Client) capCarry(msgs [][]byte) [][]byte {
	if len(msgs) <= outboxSize {
		return msgs
	}
	drop := len(msgs) - outboxSize
	n := c.dropped.Add(uint64(drop))
	log.Printf("WS carry over outboxSize — dropped %d oldest queued message(s) (total dropped: %d)", drop, n)
	return msgs[drop:]
}

func (c *Client) writeLoop(conn *websocket.Conn, stop <-chan struct{}, done chan<- struct{}, ackCh <-chan uint64) {
	defer close(done)
	ticker := time.NewTicker(c.pingPeriod)
	defer ticker.Stop()

	// All state below is local to this one connection's writer, so a stale
	// value can never leak into the next connection (that was a real bug in
	// an earlier version of this file, which kept confirmation state on the
	// Client itself).
	var (
		unconfirmed    [][]byte           // every message written on this connection, oldest first, not yet proven delivered
		totalWritten   int                // count of messages ever appended to unconfirmed on this connection
		droppedThrough int                // totalWritten value already proven delivered
		pingSeq        uint64             // last Ping sequence number sent
		boundaries     = map[uint64]int{} // pingSeq -> totalWritten at the time that Ping was sent
	)

	ack := func(seq uint64) {
		target, ok := boundaries[seq]
		if !ok {
			return // stale/unknown sequence; nothing to do
		}
		if target > droppedThrough {
			n := target - droppedThrough
			if n > len(unconfirmed) {
				n = len(unconfirmed)
			}
			unconfirmed = unconfirmed[n:]
			droppedThrough = target
		}
		for k := range boundaries {
			if k <= seq {
				delete(boundaries, k)
			}
		}
	}

	// drainAck applies a pong ack that's already buffered in ackCh, if any,
	// without blocking. ackCh is buffered (size 1) and a pong is guaranteed
	// (by TCP's in-order, per-direction delivery) to arrive before the read
	// error that follows it on a dying connection, so by the time giveUp
	// runs, any ack the peer actually sent is already sitting here — this
	// keeps "was it confirmed" independent of which ready channel the outer
	// select happens to pick first.
	drainAck := func() {
		select {
		case seq := <-ackCh:
			ack(seq)
		default:
		}
	}

	// giveUp hands everything still outstanding — unconfirmed writes plus
	// tail, an explicit list of messages this writer never got to attempt —
	// back to carry so the next connection resends it, in order, first.
	// c.carry is always nil here: it was drained into the local `msgs` at
	// the top of this writer's carry-flush (see below), and nothing else
	// ever writes to it while this writer is the sole owner of the field.
	giveUp := func(tail [][]byte) {
		drainAck()
		merged := unconfirmed
		if len(tail) > 0 {
			merged = append(merged, tail...)
		}
		unconfirmed = nil
		if len(merged) == 0 {
			return
		}
		c.carry = c.capCarry(merged)
	}

	write := func(msg []byte) bool {
		conn.SetWriteDeadline(time.Now().Add(writeWait))
		err := conn.WriteMessage(websocket.TextMessage, msg)
		unconfirmed = append(unconfirmed, msg)
		totalWritten++
		if len(unconfirmed) > outboxSize {
			// A very long outage with a still-open (but never-acked)
			// connection could otherwise grow this forever. Drop the
			// oldest and advance droppedThrough to match, so ack()'s
			// prefix math (n := target - droppedThrough) stays correct —
			// a forced drop is bookkept exactly like an artificial ack.
			drop := len(unconfirmed) - outboxSize
			n := c.dropped.Add(uint64(drop))
			log.Printf("WS unconfirmed backlog over outboxSize — dropped %d oldest message(s) (total dropped: %d)", drop, n)
			unconfirmed = unconfirmed[drop:]
			droppedThrough += drop
		}
		if err != nil {
			log.Printf("WS write error: %v — will resend after reconnect", err)
			conn.Close() // unblocks readLoop → reconnect
			return false
		}
		return true
	}

	// sendPing tags this Ping with the current write count so the matching
	// Pong (see the pong handler in connect()) can tell us exactly how much
	// of unconfirmed it vouches for.
	sendPing := func() bool {
		pingSeq++
		boundaries[pingSeq] = totalWritten
		conn.SetWriteDeadline(time.Now().Add(writeWait))
		if err := conn.WriteMessage(websocket.PingMessage, []byte(strconv.FormatUint(pingSeq, 10))); err != nil {
			conn.Close()
			return false
		}
		return true
	}

	if len(c.carry) > 0 {
		msgs := c.carry
		c.carry = nil
		for i, msg := range msgs {
			select {
			case <-stop:
				giveUp(msgs[i:])
				return
			default:
			}
			if !write(msg) {
				giveUp(msgs[i+1:])
				return
			}
		}
	}
	for {
		select {
		case <-stop:
			giveUp(nil)
			return
		case seq := <-ackCh:
			ack(seq)
		case msg := <-c.outbox:
			if !write(msg) {
				giveUp(nil)
				return
			}
		case <-ticker.C:
			if !sendPing() {
				giveUp(nil)
				return
			}
		}
	}
}

// Flush blocks until every message queued via Send before the call has been
// handed off by the writer — i.e. the outbox is empty, plus a short grace
// period for the in-flight WriteMessage of the last dequeued message to
// finish — or timeout elapses, whichever comes first. Used on shutdown,
// between DisconnectAll (which queues each bot's final offline bot_status via
// Send) and Close, so Node sees the bots go offline instead of the write
// racing the connection teardown.
//
// It deliberately does not wait for delivery *confirmation* (the pong-ack /
// carry bookkeeping in writeLoop) — that needs a full ping/pong round trip
// and can take up to pingPeriod, far longer than a graceful-shutdown budget
// should block for. carry is owned by the single writer goroutine with no
// lock protecting it (see its doc comment on Client), so reading it from here
// would race; len() on a channel is safe for concurrent use, so polling
// len(c.outbox) is the race-free signal available to a non-writer caller.
func (c *Client) Flush(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for len(c.outbox) > 0 && time.Now().Before(deadline) {
		time.Sleep(15 * time.Millisecond)
	}
	const grace = 50 * time.Millisecond
	if remaining := time.Until(deadline); remaining > 0 {
		if remaining > grace {
			remaining = grace
		}
		time.Sleep(remaining)
	}
}

func (c *Client) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn != nil
}

func (c *Client) Close() {
	c.closeOnce.Do(func() { close(c.done) })
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
	}
	c.mu.Unlock()
}
