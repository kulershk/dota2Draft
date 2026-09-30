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
