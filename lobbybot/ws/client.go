package ws

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Client struct {
	url         string
	token       string
	conn        *websocket.Conn
	mu          sync.Mutex
	handler     func(msgType string, data json.RawMessage)
	done        chan struct{}
	connected   bool
	connectedCh chan struct{} // closed on first successful connect
	connOnce    sync.Once
	// OnConnect, if set, is invoked after every successful (re)connect — not
	// just the first. Used to push state back to Node that may have been lost
	// when the WS dropped (e.g. server_steam_id re-emit after Node restart).
	OnConnect func()
}

func NewClient(wsURL, token string, handler func(string, json.RawMessage)) *Client {
	return &Client{
		url:         wsURL,
		token:       token,
		handler:     handler,
		done:        make(chan struct{}),
		connectedCh: make(chan struct{}),
	}
}

// WaitConnected blocks until the first successful WS connection.
func (c *Client) WaitConnected() {
	<-c.connectedCh
}

func (c *Client) Run() {
	// Exponential backoff between dial attempts; reset once a connection is
	// actually established so a long-lived link that drops reconnects fast
	// instead of inheriting the backoff of dial failures from hours ago.
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

		delaySec := math.Pow(2, float64(attempt))
		if delaySec > 15 {
			delaySec = 15
		}
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

// connect dials the WS and runs the read loop until the connection drops.
// The bool reports whether a connection was established at all (used to reset
// the caller's backoff); the error is the dial or read failure.
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
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		return false, fmt.Errorf("dial failed: %w", err)
	}

	c.mu.Lock()
	c.conn = conn
	c.connected = true
	c.mu.Unlock()

	log.Println("WS connected")
	c.connOnce.Do(func() { close(c.connectedCh) })

	// Send hello
	c.Send("hello", map[string]string{"version": "1.0"})

	// Fire reconnect hook in a goroutine so it can't block the read loop.
	if c.OnConnect != nil {
		go c.OnConnect()
	}

	// Read loop
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("WS read error: %v", err)
			c.mu.Lock()
			c.connected = false
			c.conn = nil
			c.mu.Unlock()
			return true, err
		}

		var env struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(message, &env); err != nil {
			log.Printf("Invalid message: %v", err)
			continue
		}

		if c.handler != nil {
			c.handler(env.Type, env.Data)
		}
	}
}

func (c *Client) Send(msgType string, data interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.conn == nil {
		return fmt.Errorf("not connected")
	}

	dataBytes, err := json.Marshal(data)
	if err != nil {
		return err
	}

	env := struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}{
		Type: msgType,
		Data: dataBytes,
	}

	return c.conn.WriteJSON(env)
}

func (c *Client) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

func (c *Client) Close() {
	close(c.done)
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
	}
	c.mu.Unlock()
}
