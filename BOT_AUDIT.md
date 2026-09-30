# Dota 2 Bot Pipeline — Audit Findings

Full correctness audit of the lobby-bot system: Go service (`lobbybot/`), Node orchestrator (`server/services/botPool.js`), routes (`server/routes/lobby.js`), queue flow (`server/socket/matchReady.js`), DB (`server/db.js`), and admin UI (`src/pages/admin/AdminBotsPage.vue`).

Every finding below was verified by reading the actual code. Status legend: ☐ open · ☑ fixed.

---

## 🔴 Critical

- ☑ **C1 — Unauthenticated lobby GET leaks the lobby password** — `server/routes/lobby.js:222`
  No `requireCompPermission` (unlike the POST at `:202`). Runs `SELECT *` and returns the row incl. `match_lobbies.password` (`db.js:662`). Also does DB writes (`UPDATE … status`, lines 235/243) for anonymous callers. Sequential `matchId`/`gameNumber` → anyone can read the password and join a private game.
  **Fix:** add `requireCompPermission(req, res, compId)` + verify match belongs to `compId`; return only the fields the client needs (never `password` to non-owners).

- ☑ **C2 — IDOR on launch / cancel / reset** — `server/routes/lobby.js:252, 274, 296`
  Permission is checked against `compId`, but the lobby is looked up by `matchId + gameNumber` only — the match is never verified to belong to `compId`. A manager of comp A can launch/cancel/hard-delete comp B's and queue lobbies.
  **Fix:** add `AND competition_id = $compId` (or a `matches` ownership check like the create route at `:212`) to each lookup.

- ☑ **C3 — Hardcoded `"waiting"` clobbers real lobby status** — `lobbybot/bot/bot.go:936`
  Line 759 sends the correctly-derived `cointoss`/`active`/`waiting`; line 936 then sends a hardcoded `"waiting"` on every cache tick, overwriting it. Re-breaks commit `0f505d1`. Live games display "waiting".
  **Fix:** delete the trailing hardcoded send (the derived send at 759 already covers it), or reuse the derived `lobbyStatus`.

- ☑ **C4 — Concurrent-map panic on `expectedTeams`** — `lobbybot/bot/bot.go:951` / read at `898`
  `SetExpectedTeams` rebuilds the map with no lock while `processLobbyUpdate` reads it from the GC-event and 15s-poll goroutines → fatal `concurrent map read and map write`, crashes all bots in the process.
  **Fix:** guard `expectedTeams` (and `lastLobby`/`launchSent`/`gameStartedSent`/`activeLobbyID`) with `b.mu`, or snapshot under lock.

- ☑ **C5 — Cross-goroutine nil-deref of `dotaClient`/`steamClient`** — `lobbybot/bot/bot.go:204`
  `reconnect`/`Disconnect` set these to nil (392/425/429) while the SayHello goroutine (204) and `processLobbyUpdate` deref them unlocked → nil-pointer panic crashes the process.
  **Fix:** pointer writes now happen under `b.mu`; all deref sites snapshot via `b.dc()` / a locked local before use (SayHello goroutine, `processLobbyUpdate`, `watchLobbyCacheEvents`, `CreatePracticeLobby`, `RequestMatchDetails`, Launch/Leave/Destroy/Invite/Poll). The fatal nil-deref class is closed.
  **Residual (not a crash):** `lastLobby` / `launchSent` / `gameStartedSent` are still mutated inside `processLobbyUpdate` without `b.mu` while the 15s poll and cache watcher can overlap — a word-sized data race that can at worst duplicate/skip a launch, not panic. Deserves a dedicated lock-audit pass under `go test -race` (no bot tests exist yet). Tracked as a follow-up.

---

## 🟠 High

- ☑ **H1 — Stale WS `close` nulls the live connection** — `server/services/botPool.js:58`
  `ws.on('close')` does `this.goWs = null` unconditionally; a superseded socket's late close wipes the live reconnected one. All Node→Go commands break until next reconnect.
  **Fix:** `if (this.goWs === ws) this.goWs = null`.

- ☑ **H2 — Non-atomic bot claim → double-booking** — `server/services/botPool.js:349` + `1994` / `2099`
  `_findAvailableBotId` is a bare `SELECT … LIMIT 1`; ~15 awaits pass before the bot is marked `busy`. Concurrent tournament+queue creates claim the same bot.
  **Fix:** atomic claim — `UPDATE lobby_bots SET status='busy' WHERE id=(SELECT … FOR UPDATE SKIP LOCKED) RETURNING id`, or a single `UPDATE … WHERE status='available' … RETURNING`.

- ☑ **H3 — `parseCompSettings` destroys legal zero values** — `server/helpers/competition.js:36, 39`
  `Number(x) || default` collapses `lobbyServerRegion 0` (US West)→3 and `lobbyDotaTvDelay 0` (None)→1. Settings page round-trips → permanent corruption on next save.
  **Fix:** use a `numOr(v, default)` helper that only falls back on `null`/`undefined`/`NaN`, not on `0`.

- ☑ **H4 — Queue region 0 (US West) coerced to 3** — `server/services/botPool.js:2044` (+INSERTs `2097`, `2213`, `2302`)
  `pool.lobby_server_region || 3` rewrites 0→3; queue pools can never host US West, and the stored value is corrupted too.
  **Fix:** `pool.lobby_server_region ?? 3` at every site.

- ☑ **H5 — DotaTV delay values wrong** — `lobbybot/bot/bot.go:1102`
  UI int cast verbatim into `LobbyDotaTVDelay` (seconds: 0=10s, 1=120s, 2=300s, 3=900s). Default "10 min" → 2 min; "2 min" → 15 min; "None" → 10s. CLAUDE.md table is also wrong.
  **Fix:** map UI value → correct enum explicitly; fix the CLAUDE.md table and the UI options to match the real GC enum.

- ☑ **H6 — `ClientWelcomed` unconditionally sets `available`** — `lobbybot/bot/bot.go:282`
  The adjacent `GCConnectionStatusChanged` handler (`:293`) guards on `activeLobbyID==""`, but `ClientWelcomed` does not → a GC re-welcome mid-lobby double-books the bot.
  **Fix:** same `if b.activeLobbyID == ""` guard before `setStatus(StatusAvailable)`.

- ☑ **H7 — Reconcile wipes `error_message`** — `server/services/botPool.js:215` (via `331`)
  `_syncBotStatusesFromGo` calls `_onBotStatus({botId, status})` with no `error`, and `_onBotStatus` does `else updates.error_message = null`. Every admin-page load erases the error text it should display.
  **Fix:** only clear `error_message` when a status event actually carries error info / on an explicit non-error status; don't null it during a bare reconcile.

---

## 🟡 Medium

- ☑ **M1 — `pendingAuth` never cleared on guard timeout/cancel** — `lobbybot/bot/bot.go:233, 237`
  On 5-min timeout or `cancelCh`, `pendingAuth` stays `true`; later `DisconnectedEvent` (322) sees `waiting=true` and `continue`s forever, never reconnecting.
  **Fix:** set `b.pendingAuth = false` in the timeout and cancel branches.

- ☑ **M2 — Stale `cancelCh` token aborts a future reconnect** — `lobbybot/bot/bot.go:345`
  `cancelCh` is buffered(1); `Disconnect` sends a token (412) that may never be drained. A later transient-blip reconnect select reads it → bot goes offline instead of reconnecting.
  **Fix:** drain `cancelCh` at the start of `Connect`/`reconnect`, or use a fresh cancel channel per session.

- ☑ **M3 — `Connect()` double-connect guard is check-then-act** — `lobbybot/bot/bot.go:117`
  Lock released between reading `Status` and acting; two near-simultaneous connects spawn duplicate Steam clients/event loops.
  **Fix:** hold `b.mu` across the check *and* the `setStatus(StatusConnecting)` transition (compare-and-set).

- ☑ **M4 — Auto-reconnect has no failure backoff** — `server/services/botPool.js:1174`
  `_reconnectAutoConnectBots` retries `error`/`offline` bots every 5 min, re-minting Steam tokens for bad-credential/guard-stuck bots forever → Steam rate-limit risk.
  **Fix:** track consecutive failures per bot and exponentially back off / stop after N; skip bots in `awaiting_guard`.

- ☑ **M5 — `gameStartedCh` never drained between lobbies** — `lobbybot/lobby/manager.go:242` / `bot.go:78, 866`
  Per-bot buffered(1) channel; a stale token makes the next lobby "start" instantly and get abandoned.
  **Fix:** drain the channel when a new lobby starts (`runLobby`), or make it per-lobby.

- ☑ **M6 — `CancelLobby` frees the bot while `runLobby` is still cleaning up** — `lobbybot/lobby/manager.go:414`
  `SetBusy(false)` runs immediately; the still-running `runLobby` then clears `activeLobbyID`/`expectedTeams` of whatever new lobby the bot was reassigned to.
  **Fix:** let `runLobby` own the free/cleanup (signal via ctx and wait), don't double-free in `CancelLobby`.

- ☑ **M7 — `autoAssignTeams` toggle is dead** — `lobbybot/lobby/manager.go:120`
  Stored but never read; kick-enforcement runs unconditionally.
  **Fix:** gate the enforcement block on `lobby.AutoAssignTeams`, or remove the option.

- ☑ **M8 — `SetBusy(false)` always advertises `available`** — `lobbybot/bot/bot.go:1008`
  No GC/connection health check → a bot with a dead GC session gets the next match.
  **Fix:** only go `available` if GC session is live; otherwise `connecting_gc`/`error`.

- ☑ **M9 — Match outcome ≠ 2 recorded as Dire win** — `lobbybot/bot/bot.go:485`
  `radiantWin := outcome == 2`; Unknown(0) and NotScored(64–69) become bogus Dire victories.
  **Fix:** switch on outcome — 2=radiant, 3=dire, else "not scored" (don't record a winner).

- ☑ **M10 — Lobby reset orphans the bot** — `server/routes/lobby.js:306`
  Deletes `match_lobbies` rows without `cancelLobby`; Go lobby stays live, bot stuck `busy`.
  **Fix:** call `botPool.cancelLobby(lobby.id)` for each active lobby before/instead of the raw DELETE.

- ☑ **M11 — matchReady handlers crash-prone + stale bot pre-check** — `server/socket/matchReady.js:45–71`
  DB awaits outside try/catch → transient DB error = unhandled rejection = server crash. And the `:71` bot-availability pre-check reads the stale DB mirror (no Go reconcile) while `createLobby` reconciles → both-ready captains falsely told "no bot available".
  **Fix:** wrap each async handler body in try/catch; drop the redundant `:71` pre-check (or reconcile first).

- ☑ **M12 — `/ws/lobbybot` fails open** — `server/index.js:197`
  `if (expected && token !== expected)` — when `BOT_SERVICE_TOKEN` is unset/empty, no check; any client can impersonate the Go service.
  **Fix:** reject the upgrade when the token is unconfigured (fail closed).

- ☑ **M13 — `POST /api/admin/bots` returns the plaintext password** — `server/routes/lobby.js:51` + `botPool.js:1631`
  `addBot` does `RETURNING *`; route does `res.json(bot)` → password in response body.
  **Fix:** return only safe fields (`id, username, status, …`), never `password`.

- ☑ **M14 — Docs out of date (violates CLAUDE.md rule)** — `server/docs/openapi.json`, `server/docs/asyncapi.json`
  13 of 18 `lobby.js` routes missing from `openapi.json`; `lobby:teamIds`, `lobby:matchIdCaptured`, `queue:cancelled`, `queue:error` missing from `asyncapi.json`.
  **Fix:** document every route/event per the project rule (fold into the relevant fix commits).

---

## 🟢 Low

- ☑ **L1 — `bot:steamGuardRequired` never emitted** — `src/pages/admin/AdminBotsPage.vue:329`
  Frontend subscribes to it; server never sends it (grep-confirmed) → Guard modal never auto-opens.
  **Fix:** emit the event from the status handler when a bot enters `awaiting_guard`, or open the modal off the status badge.

- ☑ **L2 — Avatar upload buffers before auth** — `server/routes/lobby.js:169`
  `multer` runs before the permission check → unauth clients can buffer 5 MB.
  **Fix:** check permission before the multer middleware (or apply an auth guard ahead of it).

- ☐ **L3 — Series score never carried** — `lobbybot/bot/bot.go:1113`
  Only `SeriesType` is set; `RadiantSeriesWins`/`DireSeriesWins` never set → game 2+ of a Bo3 shows 0-0.
  **Fix:** pass the current series score into the lobby details for games ≥ 2.
  **Deferred:** needs new payload fields + Node computing the running series score from prior games. Cosmetic only (the in-lobby series counter); real results are tracked in the DB. Left for a dedicated change.

- ☐ **L4 — Lobby timeout counts until game start, not player assembly** — `lobbybot/lobby/manager.go:248`
  A full, unlaunched lobby is destroyed at `timeoutMinutes`.
  **Fix:** reset/stop the timeout once all expected players have joined.
  **Deferred:** requires runLobby to learn "all expected players joined" (a new bot→manager signal) and restructure the select's timer. Behaviour-changing in the lobby lifecycle; wants runtime testing. Workaround today: raise `lobbyTimeoutMinutes`. Left for a dedicated change.

---

## Status

**28 of 30 fixed** across four themed commits on branch `fix/bot-pipeline-audit`. Remaining: L3, L4 (both low severity, deferred with notes above). One documented non-crash residual under C5 (poll-vs-watcher field races) also left for a race-detector pass.

## Order used

1. **Batch A (high-impact, low-risk):** C1, C2, C3, H1, H3, H4, M10, M12, M13, M14, L2.
2. **Batch B (Go concurrency):** C4, C5, H6, M1, M2, M3, M5, M8.
3. **Batch C (remaining correctness/UX):** H2, H5, H7, M4, M6, M7, M9, M11, L1.

---

## 2026-09-30 audit (lobbybot hardening plan)

Second pass over the same pipeline, focused on the Go↔Node bridge (WS delivery, reconnect races, GC session handling) and lobby/queue lifecycle edge cases surfaced after the first audit shipped. Status legend as above: ☐ open · ☑ fixed.

### Findings

| # | Status | Sev | Where | Defect | Commit(s) |
|---|---|---|---|---|---|
| F1 | ☑ | C | `botPool.js:1552,1616,1630` | `comp`/`settings` are block-scoped, so `_autoFillGameWinner` throws a ReferenceError. Tournament brackets never auto-advance and series XP is never awarded. | `fdd0d29` |
| F2 | ☑ | M | `server/index.js` `fetch_match_stats` | The job never checks whether the game's `dotabuff_id` changed, so it polls a dead match ID for 7 days. | `60ed3cc` |
| F3 | ☑ | L | `lobby/manager.go:252` | Lobby password is written into persisted bot logs. | `b65d91e` |
| F4 | ☑ | H | `bot.go:513` | The `case error` branch reconnects even after a hard failure (LoggedInElsewhere), so the ping-pong continues. | `b65d91e` |
| F5 | ☑ | H | `bot.go:347` | Rate-limit and throttle logon results are treated as a bad token, so Node wipes a good token and re-mints it. | `b65d91e` |
| F6 | ☑ | H | `bot.go:264,403,422` + `botPool.js:1101` | A busy bot stays `connecting_gc` after a reconnect, and Node's 5-minute watchdog restarts it mid-lobby. | `4c16f4c` |
| F7 | ☑ | H | `ws/client.go` | Events are dropped while the WS is down. No write deadline and no heartbeat, so one stalled write freezes every bot. | `7f6f2c8`, `1926deb`, `daa2688` |
| F8 | ☑ | H | `bot.go:1307` | After a reconnect, only `lobby_server_id` is replayed. A lost `game_started` is never re-sent. | `c10c101`, `c285f96` |
| F9 | ☑ | M | `botPool.js:49` | Go messages are handled concurrently, so their DB effects interleave. | `99b3ae0` |
| F10 | ☑ | H | `bot.go:945` | The roster uses the raw `all_members` list, which keeps stale entries at left/free indices. | `9e8c996` |
| F11 | ☑ | L | `bot.go:1009` | READYUP/NOTREADY/SERVERASSIGN are reported as `waiting`, which flips the row back and re-triggers auto-launch. | `9e8c996` |
| F12 | ☑ | M | `botPool.js:490,688` + `manager.go:488` | Queue auto-launch fires on every `waiting` tick, and `ForceLaunch` has no de-dupe. | `9e8c996`, `9e73f34` |
| F13 | ☑ | H | `botPool.js:525` | `game_started` marks the lobby `completed` and frees the bot before the draft starts, so an aborted start can't recover. | `98c8585`, `394c454`, `551da24` |
| F14 | ☑ | M | `bot.go:1148`, `manager.go:80` | Game start is edge-triggered, and the edge is lost on reconnect or startup. | `98c8585` |
| F15 | ☑ | M | `bot.go:859,910` | The stale-lobby sweep leaves instead of destroying, handing host to a random player. | `7d295cd`, `cb20261` |
| F16 | ☑ | L | `manager.go:250` | Cancelling during creation still sends invites. | `7d295cd`, `cb20261` |
| F17 | ☑ | L | `manager.go:314` | Rejoin doesn't check that the bot isn't already running another lobby. | `7d295cd`, `cb20261` |
| F18 | ☑ | M | `bot.go:278,427` | GC Hello is sent at most twice and never after NO_SESSION, so the bot is stuck `connecting_gc` forever. | `5cedaba`, `7156cb2` |
| F19 | ☑ | M | `bot.go:409` | Every GC welcome leaks another lobby-cache watcher, so events are processed N times. | `5cedaba`, `7156cb2` |
| F20 | ☑ | L | `bot.go:271` | A repeat `AccountInfoEvent` registers a second Dota client on the same Steam client. | `5cedaba`, `7156cb2` |
| F21 | ☑ | M | `bot.go:494` | `gcReady` isn't cleared until after the backoff sleep, so the bot can advertise `available` with a dead client. | `b65d91e` |
| F22 | ☑ | L | `bot.go:587,617` | `Disconnect` doesn't advance `sessionGen`, and `reconnect` doesn't disconnect the old client, so a zombie login is possible. | `d1891b0`, `d0f6247`, `a7b4b82` |
| F23 | ☑ | L | `bot.go:181` | `ConnectionTimeout` is ignored by go-steam, so there is no logon timeout. | `d1891b0`, `d0f6247`, `a7b4b82` |
| F24 | ☑ | M | `main.go:187` | SIGTERM isn't handled. The ghost Steam session left by the killed process kicks the restarted one. No `recover()` anywhere. | `f985bc6`, `096eb39` |
| F25 | ☑ | M | `botPool.js` (≈9 sites) | Unconditional "free the bot" UPDATEs let Node think a bot is available while Go still holds it. | `3493a8f`, `46cbe60`, `9dede44` |
| F26 | ☑ | M | `botPool.js:2293,2385` | Retry paths bypass the atomic claim, which re-opens double-booking. | `3493a8f`, `46cbe60`, `9dede44` |
| F27 | ☑ | M | `botPool.js:2085,2203` | A create while Go is disconnected leaves a stuck `creating` row. | `3493a8f`, `46cbe60`, `9dede44` |
| F28 | ☑ | M | `botPool.js:398` | "No bot available" logs in every offline bot inline, ignoring backoff. | `3493a8f`, `46cbe60`, `9dede44` |
| F29 | ☑ | L | `botPool.js:253,283,1025,1153` | `cointoss` is missing from the live-status lists. | `9e73f34` |
| F30 | ☑ | L | `botPool.js:1045` | Zombie cleanup never tells Go to cancel. | `9e73f34` |
| F31 | ☑ | L | `liveMatchPoller.js:109` | `startPolling` check-then-await race orphans an interval. | `9e73f34` |
| F32 | ☑ | L | `botPool.js:429` | GC match-details waiters for the same match overwrite each other. | `9e73f34` |
| F33 | ☑ | L | `routes/lobby.js:12` | Stand-ins can't see the lobby password. | `9e73f34` |
| F34 | ☑ | L | `botPool.js:1733` | Removing a bot never removes it from Go. | `9e73f34` |
| F35 | ☐ | H? | Comp/Queue lobby UIs | Region values are probably shifted relative to Valve's IDs (0 is "unspecified", not US West). Must be verified live. | awaiting live Dota-client verification of Valve region/series ids |
| F36 | ☐ | H? | Comp/Queue lobby UIs | Series-type values are probably wrong (Valve: 1=Bo3, 2=Bo5). Must be verified live. | awaiting live Dota-client verification of Valve region/series ids |

### Also fixed beyond the plan

- WS delivery is at-least-once with pong-sequence acks.
- `lobby_error` carries a `kind: launch_rejected` so Node can distinguish a rejected launch from a transport error.
- Per-launch abort reporting (`EnsureAbortReported`/`abortReported`) so an aborted launch is reported exactly once, including across reconnects.
- `GET` lobby route no longer auto-completes lobbies just because a match id is present.
- Hello-loop generation takeover closes exit races between overlapping GC-hello goroutines.
- The logon timer is paused during Steam Guard instead of tearing down a connection that's waiting on the user.
- Panic-safe `runLobby` cleanup (recover + best-effort teardown) and the WS outbox is flushed on shutdown so in-flight events aren't lost.

### Deferred (from the plan, unchanged)

- ☐ Split `botPool.js` (2,441 lines) into `goBridge`, `botRegistry`, `lobbyLifecycle` and `resultSettlement`.
- ☐ An explicit per-lobby state machine in Go instead of the current bool flags.
- ☐ Polish of the Steam Guard code path (mostly dead, since bots log in with refresh tokens).
- ☐ Encrypting bot credentials at rest.
- ☐ Carrying the series score between games (old L3).
- ☐ Surfacing GC create-lobby rejections, which needs go-dota2 response handling.
- ☐ Persisting an admin's game-mode override across retries.

### Live checks pending (user)

- `member_indices` roster correctness against a real Dota lobby.
- Failed-load relaunch, end-to-end.
- SIGTERM restart without triggering `LoggedInElsewhere` on the resumed session.
- Region/series enum values against the live Dota client (F35, F36).
