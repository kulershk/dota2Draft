package bot

import (
	"testing"

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
