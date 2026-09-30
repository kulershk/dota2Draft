package bot

import (
	"testing"
	"time"

	"github.com/paralin/go-steam/protocol/steamlang"
)

func TestClassifyLogonFailure(t *testing.T) {
	cases := []struct {
		r    steamlang.EResult
		want logonFailureKind
	}{
		{steamlang.EResult_AccountLogonDenied, logonNeedsGuard},
		{steamlang.EResult_AccountLoginDeniedNeedTwoFactor, logonNeedsGuard},
		{steamlang.EResult_InvalidPassword, logonBadCredentials},
		{steamlang.EResult_AccessDenied, logonBadCredentials},
		{steamlang.EResult_Expired, logonBadCredentials},
		{steamlang.EResult_Revoked, logonBadCredentials},
		{steamlang.EResult_RateLimitExceeded, logonTransient},
		{steamlang.EResult_AccountLoginDeniedThrottle, logonTransient},
		{steamlang.EResult_Timeout, logonTransient},
		{steamlang.EResult_ServiceUnavailable, logonTransient},
		{steamlang.EResult_TryAnotherCM, logonTransient},
		{steamlang.EResult_Busy, logonTransient},
		{steamlang.EResult_Banned, logonHardOther},
	}
	for _, c := range cases {
		if got := classifyLogonFailure(c.r); got != c.want {
			t.Errorf("classifyLogonFailure(%v) = %v, want %v", c.r, got, c.want)
		}
	}
}

func TestHandleDropHardFailureStops(t *testing.T) {
	b, r := newTestBot()
	b.Status = StatusError
	b.loginFailedHard = true
	b.gcReady = true
	if exit := b.handleDrop(1, make(chan struct{}), "Disconnected"); !exit {
		t.Fatal("hard failure must exit the event loop")
	}
	if b.gcReady {
		t.Error("gcReady must be cleared on drop")
	}
	if s := lastStatus(r); s == StatusConnecting {
		t.Errorf("must not start reconnecting after a hard failure, last status %q", s)
	}
}

func TestHandleDropWhileAwaitingGuardKeepsLoop(t *testing.T) {
	b, _ := newTestBot()
	b.Status = StatusAwaitGuard
	b.pendingAuth = true
	if exit := b.handleDrop(1, make(chan struct{}), "Disconnected"); exit {
		t.Fatal("drop while waiting for a Steam Guard code must keep the loop alive")
	}
}

func TestHandleDropOfflineExits(t *testing.T) {
	b, _ := newTestBot()
	b.Status = StatusOffline
	if exit := b.handleDrop(1, make(chan struct{}), "Disconnected"); !exit {
		t.Fatal("an offline bot must not reconnect")
	}
}

func TestOnGCReadyKeepsBusyBotBusy(t *testing.T) {
	b, r := newTestBot()
	b.Status = StatusConnectingGC
	b.activeLobbyID = "42"
	b.onGCReady()
	if got := lastStatus(r); got != StatusBusy {
		t.Fatalf("busy bot after GC ready: got %q, want %q", got, StatusBusy)
	}
	if !b.gcReady {
		t.Error("gcReady must be set")
	}
}

func TestOnGCReadyIdleBotAvailable(t *testing.T) {
	b, r := newTestBot()
	b.Status = StatusConnectingGC
	b.onGCReady()
	if got := lastStatus(r); got != StatusAvailable {
		t.Fatalf("idle bot after GC ready: got %q, want %q", got, StatusAvailable)
	}
}

func TestHelloInterval(t *testing.T) {
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, 60 * time.Second, 60 * time.Second}
	for i, w := range want {
		if got := helloInterval(i + 1); got != w {
			t.Errorf("helloInterval(%d) = %v, want %v", i+1, got, w)
		}
	}
}

func TestHelloLoopRetriesUntilReady(t *testing.T) {
	b, _ := newTestBot()
	b.sessionGen = 3
	b.helloFirstDelay = 0
	b.helloIntervalFn = func(int) time.Duration { return 10 * time.Millisecond }
	calls := 0
	done := make(chan struct{})
	go func() {
		b.helloLoop(3, make(chan struct{}), func() {
			calls++
			if calls == 3 {
				b.mu.Lock()
				b.gcReady = true
				b.mu.Unlock()
			}
		})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("hello loop did not stop once the GC was ready")
	}
	if calls != 3 {
		t.Fatalf("hello sent %d times, want 3", calls)
	}
}

func TestHelloLoopStopsOnNewSession(t *testing.T) {
	b, _ := newTestBot()
	b.sessionGen = 4 // loop was started for gen 3
	b.helloFirstDelay = 0
	calls := 0
	b.helloLoop(3, make(chan struct{}), func() { calls++ })
	if calls != 0 {
		t.Fatalf("stale-generation loop sent %d hellos", calls)
	}
}

// A loop left over from a dropped session (sleeping in a long backoff) must
// not block the new session's hellos — reconnect reuses the cancel channel, so
// the old loop only notices it is stale when its sleep ends (up to 60s).
func TestHelloLoopNewSessionTakesOver(t *testing.T) {
	b, _ := newTestBot()
	b.sessionGen = 1
	b.helloFirstDelay = 0
	b.helloIntervalFn = func(int) time.Duration { return time.Hour }
	stopOld := make(chan struct{})
	defer close(stopOld)
	oldSaid := make(chan struct{}, 1)
	go b.helloLoop(1, stopOld, func() { oldSaid <- struct{}{} })
	<-oldSaid // old loop is now parked in its 1h backoff

	b.mu.Lock()
	b.sessionGen = 2
	b.mu.Unlock()
	newSaid := make(chan struct{}, 1)
	stopNew := make(chan struct{})
	defer close(stopNew)
	go b.helloLoop(2, stopNew, func() {
		select {
		case newSaid <- struct{}{}:
		default:
		}
	})
	select {
	case <-newSaid:
	case <-time.After(time.Second):
		t.Fatal("new session sent no hello while the stale loop was sleeping")
	}
}

func TestDisconnectAdvancesSession(t *testing.T) {
	b, _ := newTestBot()
	b.sessionGen = 5
	b.Disconnect()
	if b.sessionGen != 6 {
		t.Fatalf("sessionGen = %d, want 6 — a pending reconnect from gen 5 must be invalidated", b.sessionGen)
	}
}

func TestReconnectStaleGenerationIsNoop(t *testing.T) {
	b, _ := newTestBot()
	b.sessionGen = 7
	b.reconnect(nil, 6, make(chan struct{}))
	if b.steamClient != nil {
		t.Fatal("a reconnect for a superseded session must not create a Steam client")
	}
}

// Y2: an older-generation loop must never take the running flag from a newer
// one — it must bail before claiming anything.
func TestHelloLoopStaleGenerationDoesNotClaimFlag(t *testing.T) {
	b, _ := newTestBot()
	b.sessionGen = 5
	b.helloRunning = false
	b.helloGen = 0
	b.helloFirstDelay = 0
	calls := 0
	b.helloLoop(3, make(chan struct{}), func() { calls++ })
	if calls != 0 {
		t.Fatalf("stale-generation loop sent %d hellos", calls)
	}
	b.mu.Lock()
	running, gen := b.helloRunning, b.helloGen
	b.mu.Unlock()
	if running || gen != 0 {
		t.Fatalf("stale-generation loop must not claim the flag: helloRunning=%v helloGen=%d", running, gen)
	}
}

// Y1 regression guard: helloRunning must be false once a loop has exited
// ready. This does NOT prove the fix on its own — Go's defer runs to
// completion before the function returns to its caller, so a single-goroutine
// call like this one can't distinguish "cleared in the same critical section
// as the exit decision" (the Y1 fix) from "cleared by the deferred cleanup"
// (the pre-fix behavior); both leave helloRunning false by the time this
// assertion runs. The actual race Y1 closes is cross-goroutine: a second
// helloLoop(gen) call landing in the window between the old loop's
// b.mu.Unlock() (after reading stale||ready) and its deferred clear actually
// running, which isn't reproducible here without test-only hooks in
// production code. Kept as a guard that the observable end state is correct.
func TestHelloLoopClearsRunningFlagOnReadyExit(t *testing.T) {
	b, _ := newTestBot()
	b.sessionGen = 2
	b.helloFirstDelay = 0
	b.gcReady = true
	b.helloLoop(2, make(chan struct{}), func() {
		t.Fatal("say() must not be called once the GC is already ready")
	})
	b.mu.Lock()
	running := b.helloRunning
	b.mu.Unlock()
	if running {
		t.Fatal("helloRunning must be false immediately after the loop exits ready")
	}
}

// Y3: a cancel closed before (or racing) the first hello must never let a
// hello through — checked again right before each say(), not just via the
// initial/interval sleeps.
func TestHelloLoopPreClosedCancelSendsNoHello(t *testing.T) {
	b, _ := newTestBot()
	b.sessionGen = 1
	b.helloFirstDelay = 0
	for i := 0; i < 200; i++ {
		cancel := make(chan struct{})
		close(cancel)
		calls := 0
		b.mu.Lock()
		b.helloRunning = false
		b.helloGen = 0
		b.mu.Unlock()
		b.helloLoop(1, cancel, func() { calls++ })
		if calls != 0 {
			t.Fatalf("say() called on iteration %d after cancel was already closed", i)
		}
	}
}

// shouldDropForLogonTimeout must only fire for a client that is still
// connected, still on the current session generation, and never logged on —
// every other combination means there's nothing live to drop (Steam already
// tore the connection down for us, a newer session took over, or we already
// logged on) and dropping it would just be a false warning.
func TestShouldDropForLogonTimeout(t *testing.T) {
	cases := []struct {
		name                       string
		loggedOn, connected, genOK bool
		want                       bool
	}{
		{"stuck pre-logon connection — drop", false, true, true, true},
		{"already logged on — no-op", true, true, true, false},
		{"already logged on and disconnected — no-op", true, false, true, false},
		{"Steam already disconnected (guard wait / dead CM) — no-op", false, false, true, false},
		{"superseded by a newer session — no-op", false, true, false, false},
		{"disconnected and superseded — no-op", false, false, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := shouldDropForLogonTimeout(c.loggedOn, c.connected, c.genOK); got != c.want {
				t.Errorf("shouldDropForLogonTimeout(loggedOn=%v, connected=%v, genOK=%v) = %v, want %v",
					c.loggedOn, c.connected, c.genOK, got, c.want)
			}
		})
	}
}
