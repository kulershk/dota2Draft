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

	if existing, ok := m.bots[botID]; ok {
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

func (m *Manager) RemoveBot(botID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if b, ok := m.bots[botID]; ok {
		b.Disconnect()
		delete(m.bots, botID)
	}
}
