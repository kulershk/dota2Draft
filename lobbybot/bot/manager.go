package bot

import (
	"fmt"
	"sync"
)

// SendFunc is used to send events back to Node.js
type SendFunc func(msgType string, data interface{}) error

type Manager struct {
	bots map[string]*Bot
	mu   sync.RWMutex
	send SendFunc
}

func NewManager(send SendFunc) *Manager {
	return &Manager{
		bots: make(map[string]*Bot),
		send: send,
	}
}

func (m *Manager) AddBot(botID, username, password, refreshToken string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Idempotent: when Node reconnects and re-sends `sync`, leave existing bots
	// alone so we don't blow away in-flight Steam/GC sessions and lose
	// `lastLobby` state. Without this, a deploy mid-game would tear the bot
	// down here, the lobby_server_id event would never replay to Node, and the
	// live-stats poller would have to fall back to GetPlayerSummaries (which
	// fails on private profiles → manual server_steam_id injection required).
	// Trade-off: a credential rotation while the bot is in a lobby won't take
	// effect until the lobby ends — the operator should disconnect_bot first.
	if existing, ok := m.bots[botID]; ok {
		if existing.Username == username &&
			existing.Password == password &&
			existing.RefreshToken == refreshToken {
			return
		}
		existing.Disconnect()
	}

	m.bots[botID] = NewBot(botID, username, password, refreshToken, m.send)
}

func (m *Manager) ConnectBot(botID string) error {
	m.mu.RLock()
	b, ok := m.bots[botID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("bot %s not found", botID)
	}

	go b.Connect()
	return nil
}

func (m *Manager) DisconnectBot(botID string) error {
	m.mu.RLock()
	b, ok := m.bots[botID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("bot %s not found", botID)
	}

	b.Disconnect()
	return nil
}

func (m *Manager) SubmitSteamGuard(botID, code string) error {
	m.mu.RLock()
	b, ok := m.bots[botID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("bot %s not found", botID)
	}

	b.SubmitSteamGuard(code)
	return nil
}

func (m *Manager) GetBot(botID string) *Bot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.bots[botID]
}

func (m *Manager) FindAvailable() *Bot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, b := range m.bots {
		if b.IsAvailable() {
			return b
		}
	}
	return nil
}

// ResendAllLobbyState walks every bot and asks it to re-emit any in-flight
// lobby state to Node. Wired to ws.Client.OnConnect so a Node restart
// recovers server_steam_id without manual injection.
func (m *Manager) ResendAllLobbyState() {
	m.mu.RLock()
	bots := make([]*Bot, 0, len(m.bots))
	for _, b := range m.bots {
		bots = append(bots, b)
	}
	m.mu.RUnlock()
	for _, b := range bots {
		b.ResendLobbyState()
	}
}

func (m *Manager) RemoveBot(botID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if b, ok := m.bots[botID]; ok {
		b.Disconnect()
		delete(m.bots, botID)
	}
}
