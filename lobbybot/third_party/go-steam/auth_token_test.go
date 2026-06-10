package steam

import (
	"bytes"
	"encoding/base64"
	"testing"

	. "github.com/paralin/go-steam/protocol/protobuf"
	"github.com/golang/protobuf/proto"
	"google.golang.org/protobuf/encoding/protowire"
)

// The vendored CMsgClientLogon predates access_token (field 108), so LogOn
// injects it via XXX_unrecognized. Make sure the protobuf runtime actually
// emits it on the wire.
func TestAccessTokenSurvivesMarshal(t *testing.T) {
	token := "header.payload.sig"
	logon := new(CMsgClientLogon)
	logon.ClientLanguage = proto.String("english")
	logon.XXX_unrecognized = protowire.AppendTag(logon.XXX_unrecognized, 108, protowire.BytesType)
	logon.XXX_unrecognized = protowire.AppendString(logon.XXX_unrecognized, token)

	data, err := proto.Marshal(logon)
	if err != nil {
		t.Fatal(err)
	}
	var want []byte
	want = protowire.AppendTag(want, 108, protowire.BytesType)
	want = protowire.AppendString(want, token)
	if !bytes.Contains(data, want) {
		t.Fatalf("marshaled logon missing access_token field: %x", data)
	}
}

func TestSteamIdFromJwt(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"steam","sub":"76561199123456789"}`))
	id, ok := steamIdFromJwt("e30." + payload + ".sig")
	if !ok || id != 76561199123456789 {
		t.Fatalf("got %d, %v", id, ok)
	}
	if _, ok := steamIdFromJwt("not-a-jwt"); ok {
		t.Fatal("expected failure on malformed token")
	}
}
