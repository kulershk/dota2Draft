# Admin lobby history + kick — design

Date: 2026-10-01 · Branch: `feat/admin-lobby-history`

## Goal

Bot admins (`manage_bots` / `is_admin`) can, from the admin panel:

1. See every bot-run Dota lobby — live ones first, then recent history — and for a lobby: who is in it right now (every member, including unassigned/pool), who was expected, who is blocked, and a timeline of what happened (created, joins/leaves/slot moves, status changes, launch, match id, failed load, draft started, errors, admin actions).
2. Act on a live pre-game lobby: **Unassign** a player (move out of Radiant/Dire slot, stays in lobby) or **Kick** a player (remove from the lobby and block them from rejoining *this lobby*), and **Unblock**.

Primary uses: debugging a lobby that went wrong after the fact (e.g. the failed-load case), and fixing a live lobby (someone squatting a slot, wrong player).

Out of scope: tournament-organiser / queue-admin access (bot admins only), site-wide bans (the existing queue ban system covers that), kicking after the game is on a server.

## Decisions (agreed)

- Kick offers both modes; admin picks.
- "Kick" blocks the player for that lobby only; admin can unblock. Block ends with the lobby.
- Access: `manage_bots` only (and `is_admin`).
- Storage: new structured `lobby_events` table (approach A), not `bot_logs`.
- UI: separate `/admin/lobbies` page, list left / detail right, deep link `/admin/lobbies/:lobbyId`.

## 1. Data

### `lobby_events` (new)

```sql
CREATE TABLE IF NOT EXISTS lobby_events (
  id BIGSERIAL PRIMARY KEY,
  lobby_id INTEGER NOT NULL REFERENCES match_lobbies(id) ON DELETE CASCADE,
  bot_id INTEGER DEFAULT NULL,          -- bot running the lobby at the time (no FK: bots get deleted)
  type TEXT NOT NULL,
  steam_id TEXT DEFAULT NULL,           -- affected player (64-bit steam id string)
  player_id INTEGER DEFAULT NULL,       -- players.id if that steam id is a registered user
  actor_id INTEGER DEFAULT NULL,        -- admin players.id for admin_* events
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lobby_events_lobby ON lobby_events(lobby_id, id);
```

Retention: rows older than 90 days are deleted from the existing periodic cleanup in `botPool` (piggy-back on the zombie-cleanup interval; one `DELETE ... WHERE created_at < NOW() - INTERVAL '90 days'`).

### `match_lobbies` (new columns)

- `blocked_steam_ids JSONB NOT NULL DEFAULT '[]'` — steam id strings blocked from this lobby.
- `members JSONB NOT NULL DEFAULT '[]'` — latest full roster from the bot: `[{steamId, name, team, slot}]`, `team ∈ radiant|dire|unassigned|pool|spectator|other`. `players_joined` (slotted only) is kept unchanged — existing auto-launch/count logic depends on it.

### Event types (`lobby_events.type`) and `data`

| type | when | data |
|---|---|---|
| `created` | Node sends `create_lobby` (tournament, queue, retry) | `{gameName, attempt?}` |
| `status_changed` | row status actually changes | `{from, to}` |
| `player_joined` | member appears in roster diff | `{name, team, slot}` |
| `player_moved` | member's team/slot changes | `{name, fromTeam, fromSlot, toTeam, toSlot}` |
| `player_left` | member disappears from roster diff | `{name, team}` |
| `launch_requested` | forceLaunch (admin or queue auto-launch) | `{auto: bool}` (+ `actor_id` if admin) |
| `match_id_assigned` | `_onGameStarted` records a new match id | `{matchId}` |
| `game_aborted` | `_onGameAborted` rolls back | `{matchId}` |
| `draft_started` | `_onDraftStarted` completes lobby | `{matchId}` |
| `error` | `_onLobbyError` applied | `{kind, message}` |
| `cancelled` | lobby cancelled | `{}` |
| `admin_unassign` / `admin_kick` / `admin_unblock` | admin action accepted | `{}` + `actor_id` |
| `kick_result` | bot reports outcome | `{mode, ok, reason, auto}` |

Only record an event when the underlying write actually changed something (rowCount > 0 / real diff) so Go's at-least-once replays never duplicate events.

Roster diff: in `_onLobbyStatus`, compare the stored `members` with the incoming `members` (keyed by steamId) **before** overwriting, emit joined/moved/left, then store. Skip the diff if the incoming event has no `members` field (old bot build) — backward compatible. Skip the bot's own steam id (Go already excludes it; Node double-checks against `lobby_bots.steam_id`).

`player_id` resolution: `SELECT id FROM players WHERE steam_id = $1` (batch per diff).

## 2. Protocol (Go ↔ Node)

### Node → Go (new commands)

```jsonc
// one-shot action
{"type":"kick_player","data":{"lobbyId":"412","steamId":"7656119...","mode":"unassign"|"kick"}}
// full-state block list (idempotent; sent after every kick/unblock and for every live lobby on Go `hello`)
{"type":"set_lobby_blocklist","data":{"lobbyId":"412","steamIds":["7656119..."]}}
```

`create_lobby` and `rejoin_lobby` payloads gain `blockedSteamIds: string[]` (both `_buildGoLobbyPayload` and `_buildCompLobbyPayload`, and the rejoin payload).

### Go → Node

- `lobby_status` gains `members: [{steamId, name, team, slot}]` — all live members (`liveMembers`) except the bot itself. team mapping: GOOD_GUYS→radiant, BAD_GUYS→dire, PLAYER_POOL→pool, NOTEAM/unassigned→unassigned, spectator/broadcaster→spectator, else other. `playersJoined` unchanged.
- New `kick_result {lobbyId, steamId, mode, ok, reason, auto}`; `reason ∈ "" | not_in_lobby | lobby_gone | timeout | no_gc`.

## 3. Go bot (`lobbybot/`)

- `protocol/messages.go`: `KickPlayerCmd`, `SetLobbyBlocklistCmd`, `LobbyMember`, `KickResultEvent`; `LobbyStatusEvent.Members []LobbyMember \`json:"members"\`` (always emitted, even empty, so Node can tell new vs old bot builds: nil → omit only if the lobby is unknown); `CreateLobbyCmd.BlockedSteamIDs`, `RejoinLobbyCmd.BlockedSteamIDs`.
- `main.go`: dispatch `kick_player`, `set_lobby_blocklist` to the manager, which finds the bot owning `lobbyId` (ignore silently + log if none; for kick_player emit `kick_result{ok:false, reason:"lobby_gone"}`).
- Bot state: `blocked map[uint64]struct{}` guarded like `expectedTeams`; `SetBlocked(ids)` replaces the set; cleared when the lobby is released.
- Enforcement: in `processLobbyUpdate`'s enforce pass (runs every cache update), any live member in `blocked` (any team) → `KickLobbyMember(accountID)`, rate-limited to once per 5 s per player; each auto-kick attempt emits `kick_result{mode:"kick", auto:true, ok:true}` only when the member is observed gone (same verifier as below), not on every retry. Only while lobby state is UI (pre-launch).
- Manual kick: `KickPlayer(steamID, mode)`:
  - GC not ready → `kick_result{ok:false, reason:"no_gc"}`.
  - Member not in current live members → `{ok:false, reason:"not_in_lobby"}`.
  - mode `kick` → `KickLobbyMember`; mode `unassign` → `KickLobbyMemberFromTeam`.
  - Verifier goroutine (wrapped in `safe.Recover`): poll the lobby cache (`getLastLobby`) every 250 ms up to 10 s; success when (kick) member absent from live members or (unassign) member team not radiant/dire. Lobby gone → `lobby_gone`; deadline → `timeout`.
  - Never target the bot's own account.
- Tests: pure functions for member mapping (`lobbyMembers(l, selfID)`), `teamLabel`, block-enforcement decision (`blockedToKick(members, blocked, lastKick, now)`), kick verification predicate. `go vet` + `go test -race` for bot/lobby/ws/safe with `GOLANG_PROTOBUF_REGISTRATION_CONFLICT=warn`.

## 4. Node server

### botPool (`server/services/botPool.js`)

- `_recordLobbyEvent(lobbyId, type, {botId, steamId, playerId, actorId, data})` — inserts, then emits `admin:lobbyEvent {lobbyId, event}` to `perm:manage_bots`. Never throws (log + swallow) — history must not break lobby flow.
- Hook points: create (all `create_lobby` send sites), `_onLobbyStatus` (status diff + roster diff; store `members`), `_onGameStarted`, `_onGameAborted`, `_onDraftStarted`, `_onLobbyError`, cancel paths, `forceLaunch` / `_autoLaunchQueueLobby`, `_onKickResult` (new `case 'kick_result'`, queued through `_enqueueGoMessage` like other lobby events).
- `kickPlayer(lobbyId, steamId, mode, actorId)`: validates (lobby exists, status `waiting`, Go connected, target in `members`, target ≠ bot steam id) → for `kick`, atomically append to `blocked_steam_ids` (no duplicates) → send `kick_player` then `set_lobby_blocklist` → record `admin_kick`/`admin_unassign`. Throws typed errors mapped to 404/409/400.
- `unblockPlayer(lobbyId, steamId, actorId)`: remove from list, send `set_lobby_blocklist` if lobby live, record `admin_unblock`. Allowed in any live status.
- On Go `hello`: after `_sendSync`, send `set_lobby_blocklist` for every live lobby (`LIVE_LOBBY_STATUSES_SQL`) with a non-empty list.
- Payload builders include `blockedSteamIds`.
- 90-day retention delete in the periodic cleanup.

### Routes (`server/routes/lobby.js`, all `requirePermission(req,res,'manage_bots')`)

- `GET /api/admin/lobbies?filter=live|recent|all&q=&before=&limit=` → `{ lobbies: [...], nextBefore }`. Live = `LIVE_LOBBY_STATUSES_SQL`; recent = everything else; default `all` ordered live first then `id DESC`. Row: `{id, status, bot_id, bot_name, match_id, game_number, competition_id, competition_name, queue_match_id?, label, players_joined_count, players_expected_count, members_count, error_message, dota_match_id, created_at, updated_at}`. `label` is a human match label ("<comp name> · Match #<id> G<n>" or "Queue #<id>"). `q` matches lobby id, dota match id, game name, competition name, or a player name/steam id present in `members`/`players_expected`. Keyset pagination by `id` (`before`), `limit` default 50 max 200.
- `GET /api/admin/lobbies/:lobbyId` → `{ lobby (row + label + bot_name + blocked_steam_ids + members + players_expected), attempts: [{id,status,created_at}] (same match_id+game_number, other ids), events: [...lobby_events with actor_name, player_name], botLogs?: [...] }`. `?botLogs=1` adds `bot_logs` rows where `lobby_id = :lobbyId`.
- `POST /api/admin/lobbies/:lobbyId/kick {steamId, mode}` → 202 `{ok:true}` / 400 / 404 / 409 `{error}`.
- `POST /api/admin/lobbies/:lobbyId/unblock {steamId}` → 200 `{ok:true, blockedSteamIds}`.

### Socket

- New server→client `admin:lobbyEvent {lobbyId, event}` to room `perm:manage_bots` (already joined by sockets with that perm). Document in `asyncapi.json`.
- Routes documented in `openapi.json` (tag `Bots`).

### Tests (vitest, `draft_test` DB, pattern of `tests/botPool.*.test.js` + `tests/helpers/botSeed.js`)

- Roster diff: joined/moved/left recorded once; replayed identical `lobby_status` records nothing; missing `members` field records nothing and does not wipe stored members.
- Status change recorded only on real change; terminal rows unaffected.
- kickPlayer: guards (non-waiting 409, Go disconnected 409, not in members 400, bot self 400), block list append idempotent, sends `kick_player` + `set_lobby_blocklist`, records `admin_kick` with actor.
- unblockPlayer removes and resends.
- hello resends block lists for live lobbies only.
- `kick_result` recorded; payload builders include `blockedSteamIds`.
- Routes: permission (403 without manage_bots), list filter/search/pagination, detail shape.
- Add the new test files to the CI `test` job list in `.github/workflows/deploy.yml`.

## 5. Frontend

- Route `{ path: 'lobbies/:lobbyId?', name: 'admin-lobbies', meta: { permissions: ['manage_bots'] } }` → `src/pages/admin/AdminLobbiesPage.vue`. Sidebar entry in `AdminLayout.vue` next to Bots (icon from lucide, e.g. `ScrollText` or `ListTree`), label key `adminLobbies`.
- Canonical admin wrapper/header per CLAUDE.md (`text-2xl font-semibold`, CSS-var max-width).
- Left: filter (Live / Recent / All), search box (debounced), list rows (id, label, bot, status pill, joined/expected, relative time), "Load more" (keyset). Selected row highlighted; selecting updates the URL.
- Right (selected lobby): header (id, label, bot, status, dota match id link, created), "Other attempts" links; **Roster** table from `members` (name, steam id, team/slot, badges: *expected* / *not expected* / *blocked*), expected-but-absent players greyed; actions per row **Unassign** (only if radiant/dire) and **Kick**, both enabled only when status is `waiting` and Go connected; **Blocked** list with **Unblock**. **Timeline**: events oldest→newest with local time (`fmtDateTime`), human sentence per type, actor name for admin actions, ok/failed badge for `kick_result`; toggle "Show bot logs" merges `botLogs` (by time).
- Kick/unassign confirmation uses `<ModalOverlay>` + card (no `window.confirm`); warns when target is an expected player ("This player is on the team list — the lobby can't auto-launch without them").
- Live updates: listen to `admin:lobbyEvent`; if it's the selected lobby, append the event and debounce-refetch detail (roster/status); debounce-refetch the list.
- `useApi.ts`: `getAdminLobbies(params)`, `getAdminLobby(id, {botLogs})`, `kickLobbyPlayer(id, steamId, mode)`, `unblockLobbyPlayer(id, steamId)`.
- `AdminBotsPage.vue`: the existing active-lobby context on each bot card links to `/admin/lobbies/<activeLobbyId>` (only the link; no other changes).
- i18n: all new strings in `en.ts`, `lv.ts`, `lt.ts`.
- `vue-tsc` / build must pass.

## 6. Edge cases

- Lobby relaunched after failed load: row goes back to `waiting` → kick allowed again; block list persists (same row, and `create_lobby` retry rows copy it — retry builds a new row: copy `blocked_steam_ids` from the errored row).
- Go restart mid-lobby: blocks restored on `hello` resend and in `rejoin_lobby` payload.
- Kicked player was expected: allowed with warning; queue auto-launch waits; admin can cancel or unblock.
- Blocked player rejoins repeatedly: bot re-kicks at most every 5 s; one `kick_result{auto:true}` per successful removal.
- Kick on a lobby whose bot died: `kick_result{ok:false, reason:"lobby_gone"}` shown in timeline.
- Old bot build without `members`: history of lifecycle events still works; roster diff skipped; roster panel falls back to `players_joined`.
- Event write failure never blocks lobby handling.

## 7. Implementation split (parallel, disjoint files)

1. **Go** — `lobbybot/**` only.
2. **Node** — `server/**`, `tests/**`, `server/docs/**`, `.github/workflows/deploy.yml`.
3. **Frontend** — `src/**` only.

The protocol in §2 and the REST/socket shapes in §4 are the contract between them.

## 8. As built — deviations from the above

- **Member names:** go-dota2's `CSODOTALobbyMember` has no persona name, so Go always sends `name: ""`; Node resolves names from `players` (`display_name`, else `name`), falling back to the steam id.
- **Team labels:** Dota's normal "Unassigned Players" column is `PLAYER_POOL` → `pool`; `unassigned` (NOTEAM) is rare. The UI labels both "Unassigned". Node stores `slot: null` for non-Radiant/Dire members (Go sends 0), so pool members don't log fake moves.
- **`members` omitted vs empty:** manager-originated statuses (waiting-after-create, launching, cancelled) omit `members` → Node skips the diff; cache-driven statuses always include it (possibly `[]`).
- **Archive instead of delete:** re-creating a game's lobby (`createLobby` / `createQueueLobby`) and the tournament lobby *reset* route used to `DELETE` old `match_lobbies` rows, which would cascade-delete their history. They now set `match_lobbies.archived_at` (reset also force-marks any still-live row `cancelled`). Every match-keyed read — retry caps, the match-room lobby, latest-lobby lookups, standin guards, live-poll resume — filters `archived_at IS NULL`, so behaviour matches the old delete.
- **Extras:** list/detail responses include `goConnected`; `getBotStatuses` returns `active_lobby_id` (bot cards deep-link to the lobby); `kick_result` replay de-dupe (manual: only while admin requests outnumber manual results for that player; auto: drop identical within 15 s).
