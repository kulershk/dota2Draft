module lobbybot

go 1.25

require (
	github.com/gorilla/websocket v1.5.3
	github.com/paralin/go-dota2 v0.0.0-20260316004731-d7be610e635b
	github.com/paralin/go-steam v0.0.0-20250502043548-f167ff28a93a
	github.com/sirupsen/logrus v1.9.4
)

// Local patched copy: adds refresh-token (access_token) logon support, which
// Steam now requires — legacy password logon on the CM protocol is rejected
// with InvalidPassword even for correct credentials.
replace github.com/paralin/go-steam => ./third_party/go-steam

require (
	github.com/golang/protobuf v1.5.4 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	golang.org/x/sys v0.40.0 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
)
