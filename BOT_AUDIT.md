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

- ☐ **C4 — Concurrent-map panic on `expectedTeams`** — `lobbybot/bot/bot.go:951` / read at `898`
  `SetExpectedTeams` rebuilds the map with no lock while `processLobbyUpdate` reads it from the GC-event and 15s-poll goroutines → fatal `concurrent map read and map write`, crashes all bots in the process.
  **Fix:** guard `expectedTeams` (and `lastLobby`/`launchSent`/`gameStartedSent`/`activeLobbyID`) with `b.mu`, or snapshot under lock.

- ☐ **C5 — Cross-goroutine nil-deref of `dotaClient`/`steamClient`** — `lobbybot/bot/bot.go:204`
  `reconnect`/`Disconnect` set these to nil (392/425/429) while the SayHello goroutine (204) and `processLobbyUpdate` deref them unlocked → nil-pointer panic crashes the process.
  **Fix:** synchronize client access under `b.mu` (snapshot the pointer under lock before use), or gate on a generation counter.

---

## 🟠 High

- ☑ **H1 — Stale WS `close` nulls the live connection** — `server/services/botPool.js:58`
  `ws.on('close')` does `this.goWs = null` unconditionally; a superseded socket's late close wipes the live reconnected one. All Node→Go commands break until next reconnect.
  **Fix:** `if (this.goWs === ws) this.goWs = null`.

- ☐ **H2 — Non-atomic bot claim → double-booking** — `server/services/botPool.js:349` + `1994` / `2099`
  `_findAvailableBotId` is a bare `SELECT … LIMIT 1`; ~15 awaits pass before the bot is marked `busy`. Concurrent tournament+queue creates claim the same bot.
  **Fix:** atomic claim — `UPDATE lobby_bots SET status='busy' WHERE id=(SELECT … FOR UPDATE SKIP LOCKED) RETURNING id`, or a single `UPDATE … WHERE status='available' … RETURNING`.

- ☑ **H3 — `parseCompSettings` destroys legal zero values** — `server/helpers/competition.js:36, 39`
  `Number(x) || default` collapses `lobbyServerRegion 0` (US West)→3 and `lobbyDotaTvDelay 0` (None)→1. Settings page round-trips → permanent corruption on next save.
  **Fix:** use a `numOr(v, default)` helper that only falls back on `null`/`undefined`/`NaN`, not on `0`.

- ☑ **H4 — Queue region 0 (US West) coerced to 3** — `server/services/botPool.js:2044` (+INSERTs `2097`, `2213`, `2302`)
  `pool.lobby_server_region || 3` rewrites 0→3; queue pools can never host US West, and the stored value is corrupted too.
  **Fix:** `pool.lobby_server_region ?? 3` at every site.

- ☐ **H5 — DotaTV delay values wrong** — `lobbybot/bot/bot.go:1102`
  UI int cast verbatim into `LobbyDotaTVDelay` (seconds: 0=10s, 1=120s, 2=300s, 3=900s). Default "10 min" → 2 min; "2 min" → 15 min; "None" → 10s. CLAUDE.md table is also wrong.
  **Fix:** map UI value → correct enum explicitly; fix the CLAUDE.md table and the UI options to match the real GC enum.

- ☐ **H6 — `ClientWelcomed` unconditionally sets `available`** — `lobbybot/bot/bot.go:282`
  The adjacent `GCConnectionStatusChanged` handler (`:293`) guards on `activeLobbyID==""`, but `ClientWelcomed` does not → a GC re-welcome mid-lobby double-books the bot.
  **Fix:** same `if b.activeLobbyID == ""` guard before `setStatus(StatusAvailable)`.

- ☐ **H7 — Reconcile wipes `error_message`** — `server/services/botPool.js:215` (via `331`)
  `_syncBotStatusesFromGo` calls `_onBotStatus({botId, status})` with no `error`, and `_onBotStatus` does `else updates.error_message = null`. Every admin-page load erases the error text it should display.
  **Fix:** only clear `error_message` when a status event actually carries error info / on an explicit non-error status; don't null it during a bare reconcile.

---

## 🟡 Medium

- ☐ **M1 — `pendingAuth` never cleared on guard timeout/cancel** — `lobbybot/bot/bot.go:233, 237`
  On 5-min timeout or `cancelCh`, `pendingAuth` stays `true`; later `DisconnectedEvent` (322) sees `waiting=true` and `continue`s forever, never reconnecting.
  **Fix:** set `b.pendingAuth = false` in the timeout and cancel branches.

- ☐ **M2 — Stale `cancelCh` token aborts a future reconnect** — `lobbybot/bot/bot.go:345`
  `cancelCh` is buffered(1); `Disconnect` sends a token (412) that may never be drained. A later transient-blip reconnect select reads it → bot goes offline instead of reconnecting.
  **Fix:** drain `cancelCh` at the start of `Connect`/`reconnect`, or use a fresh cancel channel per session.

- ☐ **M3 — `Connect()` double-connect guard is check-then-act** — `lobbybot/bot/bot.go:117`
  Lock released between reading `Status` and acting; two near-simultaneous connects spawn duplicate Steam clients/event loops.
  **Fix:** hold `b.mu` across the check *and* the `setStatus(StatusConnecting)` transition (compare-and-set).

- ☐ **M4 — Auto-reconnect has no failure backoff** — `server/services/botPool.js:1174`
  `_reconnectAutoConnectBots` retries `error`/`offline` bots every 5 min, re-minting Steam tokens for bad-credential/guard-stuck bots forever → Steam rate-limit risk.
  **Fix:** track consecutive failures per bot and exponentially back off / stop after N; skip bots in `awaiting_guard`.

- ☐ **M5 — `gameStartedCh` never drained between lobbies** — `lobbybot/lobby/manager.go:242` / `bot.go:78, 866`
  Per-bot buffered(1) channel; a stale token makes the next lobby "start" instantly and get abandoned.
  **Fix:** drain the channel when a new lobby starts (`runLobby`), or make it per-lobby.

- ☐ **M6 — `CancelLobby` frees the bot while `runLobby` is still cleaning up** — `lobbybot/lobby/manager.go:414`
  `SetBusy(false)` runs immediately; the still-running `runLobby` then clears `activeLobbyID`/`expectedTeams` of whatever new lobby the bot was reassigned to.
  **Fix:** let `runLobby` own the free/cleanup (signal via ctx and wait), don't double-free in `CancelLobby`.

- ☐ **M7 — `autoAssignTeams` toggle is dead** — `lobbybot/lobby/manager.go:120`
  Stored but never read; kick-enforcement runs unconditionally.
  **Fix:** gate the enforcement block on `lobby.AutoAssignTeams`, or remove the option.

- ☐ **M8 — `SetBusy(false)` always advertises `available`** — `lobbybot/bot/bot.go:1008`
  No GC/connection health check → a bot with a dead GC session gets the next match.
  **Fix:** only go `available` if GC session is live; otherwise `connecting_gc`/`error`.

- ☐ **M9 — Match outcome ≠ 2 recorded as Dire win** — `lobbybot/bot/bot.go:485`
  `radiantWin := outcome == 2`; Unknown(0) and NotScored(64–69) become bogus Dire victories.
  **Fix:** switch on outcome — 2=radiant, 3=dire, else "not scored" (don't record a winner).

- ☑ **M10 — Lobby reset orphans the bot** — `server/routes/lobby.js:306`
  Deletes `match_lobbies` rows without `cancelLobby`; Go lobby stays live, bot stuck `busy`.
  **Fix:** call `botPool.cancelLobby(lobby.id)` for each active lobby before/instead of the raw DELETE.

- ☐ **M11 — matchReady handlers crash-prone + stale bot pre-check** — `server/socket/matchReady.js:45–71`
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

- ☐ **L1 — `bot:steamGuardRequired` never emitted** — `src/pages/admin/AdminBotsPage.vue:329`
  Frontend subscribes to it; server never sends it (grep-confirmed) → Guard modal never auto-opens.
  **Fix:** emit the event from the status handler when a bot enters `awaiting_guard`, or open the modal off the status badge.

- ☑ **L2 — Avatar upload buffers before auth** — `server/routes/lobby.js:169`
  `multer` runs before the permission check → unauth clients can buffer 5 MB.
  **Fix:** check permission before the multer middleware (or apply an auth guard ahead of it).

- ☐ **L3 — Series score never carried** — `lobbybot/bot/bot.go:1113`
  Only `SeriesType` is set; `RadiantSeriesWins`/`DireSeriesWins` never set → game 2+ of a Bo3 shows 0-0.
  **Fix:** pass the current series score into the lobby details for games ≥ 2.

- ☐ **L4 — Lobby timeout counts until game start, not player assembly** — `lobbybot/lobby/manager.go:248`
  A full, unlaunched lobby is destroyed at `timeoutMinutes`.
  **Fix:** reset/stop the timeout once all expected players have joined.

---

## Suggested order

1. **Batch A (high-impact, low-risk):** C1, C2, C3, H1, H3, H4 — plus M10, M12, M13, M14 docs as they're touched.
2. **Batch B (Go concurrency, needs care):** C4, C5, H6, M1, M2, M3, M8.
3. **Batch C (remaining correctness/UX):** H2, H5, H7, M4–M9, M11, L1–L4.
