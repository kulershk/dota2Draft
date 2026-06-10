package steam

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	. "github.com/paralin/go-steam/protocol"
	. "github.com/paralin/go-steam/protocol/protobuf"
	. "github.com/paralin/go-steam/protocol/steamlang"
	"github.com/paralin/go-steam/steamid"
	"github.com/golang/protobuf/proto"
	"google.golang.org/protobuf/encoding/protowire"
)

type Auth struct {
	client  *Client
	details *LogOnDetails
}

type SentryHash []byte

type LogOnDetails struct {
	Username string

	// If logging into an account without a login key, the account's password.
	Password string

	// If you have a Steam Guard email code, you can provide it here.
	AuthCode string

	// If you have a Steam Guard mobile two-factor authentication code, you can provide it here.
	TwoFactorCode  string
	SentryFileHash SentryHash
	LoginKey       string

	// true if you want to get a login key which can be used in lieu of
	// a password for subsequent logins. false or omitted otherwise.
	ShouldRememberPassword bool

	// A refresh token (JWT) obtained from Steam's modern auth flow
	// (IAuthenticationService). When set, it is used instead of the password —
	// Steam rejects legacy password logons on the CM protocol with
	// EResult_InvalidPassword even when the password is correct.
	AccessToken string
}

// Log on with the given details. You must always specify username and
// password OR username and loginkey. For the first login, don't set an authcode or a hash and you'll
//  receive an error (EResult_AccountLogonDenied)
// and Steam will send you an authcode. Then you have to login again, this time with the authcode.
// Shortly after logging in, you'll receive a MachineAuthUpdateEvent with a hash which allows
// you to login without using an authcode in the future.
//
// If you don't use Steam Guard, username and password are enough.
//
// After the event EMsg_ClientNewLoginKey is received you can use the LoginKey
// to login instead of using the password.
func (a *Auth) LogOn(details *LogOnDetails) {
	if details.Username == "" {
		panic("Username must be set!")
	}
	if details.Password == "" && details.LoginKey == "" && details.AccessToken == "" {
		panic("Password, LoginKey or AccessToken must be set!")
	}

	logon := new(CMsgClientLogon)
	logon.ClientLanguage = proto.String("english")
	logon.ProtocolVersion = proto.Uint32(MsgClientLogon_CurrentProtocol)

	headerSteamId := steamid.NewIdAdv(0, 1, int32(EUniverse_Public), EAccountType_Individual).ToUint64()

	if details.AccessToken != "" {
		// Modern token logon: account_name and password must be absent. The
		// generated CMsgClientLogon here predates the access_token field
		// (108), so append it as a raw unknown field — unknown fields are
		// marshaled verbatim. The message header must carry the SteamID the
		// token was issued for (its `sub` claim).
		logon.XXX_unrecognized = protowire.AppendTag(logon.XXX_unrecognized, 108, protowire.BytesType)
		logon.XXX_unrecognized = protowire.AppendString(logon.XXX_unrecognized, details.AccessToken)
		if sub, ok := steamIdFromJwt(details.AccessToken); ok {
			headerSteamId = sub
		}
	} else {
		logon.AccountName = &details.Username
		logon.Password = &details.Password
		if details.AuthCode != "" {
			logon.AuthCode = proto.String(details.AuthCode)
		}
		if details.TwoFactorCode != "" {
			logon.TwoFactorCode = proto.String(details.TwoFactorCode)
		}
		logon.ShaSentryfile = details.SentryFileHash
		if details.LoginKey != "" {
			logon.LoginKey = proto.String(details.LoginKey)
		}
		if details.ShouldRememberPassword {
			logon.ShouldRememberPassword = proto.Bool(details.ShouldRememberPassword)
		}
	}

	atomic.StoreUint64(&a.client.steamId, headerSteamId)

	a.client.Write(NewClientMsgProtobuf(EMsg_ClientLogon, logon))
}

// steamIdFromJwt extracts the SteamID64 from a Steam auth JWT's `sub` claim
// without verifying the signature (Steam verifies it server-side).
func steamIdFromJwt(token string) (uint64, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0, false
	}
	var claims struct {
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return 0, false
	}
	id, err := strconv.ParseUint(claims.Sub, 10, 64)
	if err != nil || id == 0 {
		return 0, false
	}
	return id, true
}

func (a *Auth) HandlePacket(packet *Packet) {
	switch packet.EMsg {
	case EMsg_ClientLogOnResponse:
		a.handleLogOnResponse(packet)
	case EMsg_ClientNewLoginKey:
		a.handleLoginKey(packet)
	case EMsg_ClientSessionToken:
	case EMsg_ClientLoggedOff:
		a.handleLoggedOff(packet)
	case EMsg_ClientUpdateMachineAuth:
		a.handleUpdateMachineAuth(packet)
	case EMsg_ClientAccountInfo:
		a.handleAccountInfo(packet)
	case EMsg_ClientWalletInfoUpdate:
	case EMsg_ClientRequestWebAPIAuthenticateUserNonceResponse:
	case EMsg_ClientMarketingMessageUpdate:
	}
}

func (a *Auth) handleLogOnResponse(packet *Packet) {
	if !packet.IsProto {
		a.client.Fatalf("Got non-proto logon response!")
		return
	}

	body := new(CMsgClientLogonResponse)
	msg := packet.ReadProtoMsg(body)

	result := EResult(body.GetEresult())
	if result == EResult_OK {
		atomic.StoreInt32(&a.client.sessionId, msg.Header.Proto.GetClientSessionid())
		atomic.StoreUint64(&a.client.steamId, msg.Header.Proto.GetSteamid())
		if body.WebapiAuthenticateUserNonce != nil {
			a.client.Web.webLoginKey = *body.WebapiAuthenticateUserNonce
		}

		go a.client.heartbeatLoop(time.Duration(body.GetOutOfGameHeartbeatSeconds()))

		a.client.Emit(&LoggedOnEvent{
			Result:         EResult(body.GetEresult()),
			ExtendedResult: EResult(body.GetEresultExtended()),
			AccountFlags:   EAccountFlags(body.GetAccountFlags()),
			ClientSteamId:  steamid.SteamId(body.GetClientSuppliedSteamid()),
			Body:           body,
		})
	} else if result == EResult_Fail || result == EResult_ServiceUnavailable || result == EResult_TryAnotherCM {
		// some error on Steam's side, we'll get an EOF later
		a.client.Emit(&SteamFailureEvent{
			Result: EResult(body.GetEresult()),
		})
	} else {
		a.client.Emit(&LogOnFailedEvent{
			Result: EResult(body.GetEresult()),
		})
		a.client.Disconnect()
	}
}

func (a *Auth) handleLoginKey(packet *Packet) {
	body := new(CMsgClientNewLoginKey)
	packet.ReadProtoMsg(body)
	a.client.Write(NewClientMsgProtobuf(EMsg_ClientNewLoginKeyAccepted, &CMsgClientNewLoginKeyAccepted{
		UniqueId: proto.Uint32(body.GetUniqueId()),
	}))
	a.client.Emit(&LoginKeyEvent{
		UniqueId: body.GetUniqueId(),
		LoginKey: body.GetLoginKey(),
	})
}

func (a *Auth) handleLoggedOff(packet *Packet) {
	result := EResult_Invalid
	if packet.IsProto {
		body := new(CMsgClientLoggedOff)
		packet.ReadProtoMsg(body)
		result = EResult(body.GetEresult())
	} else {
		body := new(MsgClientLoggedOff)
		packet.ReadClientMsg(body)
		result = body.Result
	}
	a.client.Emit(&LoggedOffEvent{Result: result})
}

func (a *Auth) handleUpdateMachineAuth(packet *Packet) {
	body := new(CMsgClientUpdateMachineAuth)
	packet.ReadProtoMsg(body)
	hash := sha1.New()
	hash.Write(packet.Data)
	sha := hash.Sum(nil)

	msg := NewClientMsgProtobuf(EMsg_ClientUpdateMachineAuthResponse, &CMsgClientUpdateMachineAuthResponse{
		ShaFile: sha,
	})
	msg.SetTargetJobId(packet.SourceJobId)
	a.client.Write(msg)

	a.client.Emit(&MachineAuthUpdateEvent{sha})
}

func (a *Auth) handleAccountInfo(packet *Packet) {
	body := new(CMsgClientAccountInfo)
	packet.ReadProtoMsg(body)
	a.client.Emit(&AccountInfoEvent{
		PersonaName:          body.GetPersonaName(),
		Country:              body.GetIpCountry(),
		CountAuthedComputers: body.GetCountAuthedComputers(),
		AccountFlags:         EAccountFlags(body.GetAccountFlags()),
		FacebookId:           body.GetFacebookId(),
		FacebookName:         body.GetFacebookName(),
	})
}
