package ws

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// outboxSize bounds memory while Node is down (a deploy is ~30s; a busy
	// lobby emits a few messages per second). Overflow drops the newest message.
	outboxSize = 2048
	writeWait  = 10 * time.Second // a single write may not block longer than this
	pongWait   = 60 * time.Second // no pong/message for this long = dead link
	pingPeriod = 20 * time.Second // must be < pongWait
)

type Client struct {
	url     string
	token   string
	handler func(msgType string, data json.RawMessage)

	// outbox holds marshalled envelopes. Send enqueues; exactly one writer
	// goroutine (per live connection) dequeues — gorilla/websocket allows only
	// one concurrent writer, and a stalled write can no longer hold a mutex
	// that every bot's setStatus/log needs.
	outbox chan []byte
	// carry holds messages the previous connection sent-but-never-confirmed;
	// the next connection's writer resends them first, in order. Only touched
	// by writers, which never overlap (connect() waits on writerDone before
	// starting the next one).
	//
	// A successful WriteMessage is not proof of delivery: a local write can
	// still succeed into the kernel send buffer after the peer has already
	// torn down the socket (the resulting RST arrives asynchronously). So a
	// message only drops off the resend list once something arrives back
	// from the server on this same connection (a message or a pong) —
	// TCP's in-order, reliable stream means that inbound proves everything
	// written before it made it out. Anything still unconfirmed when the
	// connection dies — whether the write itself errored or not — is carried
	// forward.
	carry     [][]byte
	confirmed chan struct{}
	dropped   atomic.Uint64

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
		confirmed:   make(chan struct{}, 1),
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

	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		c.markConfirmed()
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
	go c.writeLoop(conn, stop, writerDone)
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
		c.markConfirmed()
		if err := json.Unmarshal(message, &env); err != nil {
			log.Printf("Invalid message: %v", err)
			continue
		}
		c.dispatch(env.Type, env.Data)
	}
}

// markConfirmed records that the server is responsive on the current
// connection — proof (via TCP's in-order, reliable stream) that every write
// issued on this connection before now actually reached it. Non-blocking:
// the writer only cares that a confirmation happened, not how many.
func (c *Client) markConfirmed() {
	select {
	case c.confirmed <- struct{}{}:
	default:
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

func (c *Client) writeLoop(conn *websocket.Conn, stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	// unconfirmed holds, in order, every message written on this connection
	// that markConfirmed hasn't yet vouched for. giveUp hands whatever is
	// still outstanding back to carry so the next connection resends it —
	// this is the path that catches a write that reported success right as
	// the peer was tearing the socket down (see the carry doc comment).
	var unconfirmed [][]byte
	// confirmed is reused across reconnects; drain any stale signal left over
	// from the previous (now-dead) connection so it can't be mistaken for a
	// confirmation on this one.
	select {
	case <-c.confirmed:
	default:
	}
	giveUp := func() {
		if len(unconfirmed) > 0 {
			c.carry = append(unconfirmed, c.carry...)
			unconfirmed = nil
		}
	}

	write := func(msg []byte) bool {
		conn.SetWriteDeadline(time.Now().Add(writeWait))
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			log.Printf("WS write error: %v — will resend after reconnect", err)
			unconfirmed = append(unconfirmed, msg)
			giveUp()
			conn.Close() // unblocks readLoop → reconnect
			return false
		}
		unconfirmed = append(unconfirmed, msg)
		return true
	}

	if len(c.carry) > 0 {
		msgs := c.carry
		c.carry = nil
		for _, msg := range msgs {
			if !write(msg) {
				return
			}
		}
	}
	for {
		select {
		case <-stop:
			giveUp()
			return
		case <-c.confirmed:
			unconfirmed = nil
		case msg := <-c.outbox:
			if !write(msg) {
				return
			}
		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				giveUp()
				conn.Close()
				return
			}
		}
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
