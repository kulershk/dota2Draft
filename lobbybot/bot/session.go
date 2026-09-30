package bot

import (
	"fmt"
	"time"

	"github.com/paralin/go-steam/protocol/steamlang"
)

type logonFailureKind int

const (
	logonNeedsGuard     logonFailureKind = iota // Steam Guard code required
	logonBadCredentials                         // token/password rejected — Node must re-mint the token
	logonTransient                              // Steam-side throttle/hiccup — credentials are fine, back off
	logonHardOther                              // anything else (banned, disabled…) — stop, surface the error
)

func (k logonFailureKind) String() string {
	return [...]string{"needs_guard", "bad_credentials", "transient", "hard_other"}[k]
}

// classifyLogonFailure decides how to react to a LogOnFailedEvent. Only a real
// credential rejection may flag the refresh token invalid — flagging it on a
// rate limit makes Node wipe a good token and mint a new one, adding auth
// traffic to an account Steam is already throttling.
func classifyLogonFailure(r steamlang.EResult) logonFailureKind {
	switch r {
	case steamlang.EResult_AccountLogonDenied, steamlang.EResult_AccountLoginDeniedNeedTwoFactor:
		return logonNeedsGuard
	case steamlang.EResult_InvalidPassword, steamlang.EResult_AccessDenied,
		steamlang.EResult_Expired, steamlang.EResult_Revoked,
		steamlang.EResult_InvalidLoginAuthCode, steamlang.EResult_TwoFactorCodeMismatch:
		return logonBadCredentials
	case steamlang.EResult_RateLimitExceeded, steamlang.EResult_AccountLoginDeniedThrottle,
		steamlang.EResult_Timeout, steamlang.EResult_ServiceUnavailable,
		steamlang.EResult_TryAnotherCM, steamlang.EResult_Busy:
		return logonTransient
	default:
		return logonHardOther
	}
}

// handleDrop is the single path for a lost Steam connection — a
// DisconnectedEvent or a fatal go-steam error. It clears GC readiness at once
// (so SetBusy(false) during the backoff can't advertise 'available' on a dead
// client), honours hard failures (credentials rejected / kicked by another
// login) and otherwise reconnects with backoff. Returns true when the calling
// event loop must exit.
func (b *Bot) handleDrop(gen uint64, cancel <-chan struct{}, reason string) bool {
	b.mu.Lock()
	b.gcReady = false
	waiting := b.pendingAuth
	status := b.Status
	failedHard := b.loginFailedHard
	old := b.steamClient
	b.mu.Unlock()

	if waiting {
		b.log(reason + " (waiting for Steam Guard code)")
		return false
	}
	if failedHard {
		b.logAt("error", reason+" — not auto-reconnecting (hard failure, see previous error)")
		return true
	}
	if status == StatusOffline {
		return true
	}

	b.noteSessionDrop()
	delay := b.reconnectDelay()
	b.logAt("warn", fmt.Sprintf("%s — reconnecting in %s...", reason, delay))
	b.setStatus(StatusConnecting)
	select {
	case <-cancel:
		b.setStatus(StatusOffline)
		return true
	case <-time.After(delay):
	}
	if !b.claimNextSession(&gen) {
		return true
	}
	b.reconnect(old, gen, cancel)
	return true
}

// onGCReady runs when the GC session is (re)established (ClientWelcomed or
// HAVE_SESSION). A bot mid-lobby re-asserts 'busy' — never 'available', which
// would let Node double-book it — so the 'connecting'/'connecting_gc' status
// reported during the reconnect doesn't linger in Node, whose stuck-connecting
// watchdog would otherwise restart the bot and pull it out of the lobby.
func (b *Bot) onGCReady() {
	b.mu.Lock()
	b.gcReady = true
	lobbyID := b.activeLobbyID
	b.mu.Unlock()
	if lobbyID != "" {
		b.logCtx("info", lobbyID, "GC session ready while in a lobby — staying busy")
		b.setStatus(StatusBusy)
		return
	}
	b.setStatus(StatusAvailable)
}
