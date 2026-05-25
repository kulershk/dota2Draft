# Dota 2 Auction Draft — Developer Instructions

## API Documentation Rules

**Every REST route or Socket.io event change MUST include a docs update.**

When adding, modifying, or removing:

### REST API routes (`server/routes/*.js`)
- Update `server/docs/openapi.json` with the new/changed endpoint
- Include: method, path, parameters, request body schema, response schema, required permissions, tags
- Follow existing patterns in the spec for consistency

### Socket.io events (`server/socket/*.js`)
- Update `server/docs/asyncapi.json` with the new/changed event
- Include: event name, direction (publish = client→server, subscribe = server→client), payload schema, description
- Note if the event is private (single socket) or broadcast (competition room)

### Docs locations
- **OpenAPI (REST)**: `server/docs/openapi.json` — served at `/api/docs`
- **AsyncAPI (Socket.io)**: `server/docs/asyncapi.json` — served at `/api/docs/socket`
- Raw specs: `/api/docs/openapi.json` and `/api/docs/asyncapi.json`

## Date / Time Rules

The DB stores timestamps as `TIMESTAMP` (no time zone). The Node `pg` driver and the Postgres session both run in UTC, so values round-trip as UTC instants — the server returns ISO strings like `"2026-04-15T15:30:00.000Z"` to the client.

The frontend uses the generic `<DatePicker>` component which works in **local wall-clock format** (`YYYY-MM-DDTHH:mm`), not ISO. So every page that binds a DB timestamp to a `DatePicker` MUST convert in both directions using the shared helpers in `src/utils/format.ts`:

- **Server ISO → DatePicker**: `toLocalDatetime(iso)` — converts the UTC instant to the viewer's local wall clock.
- **DatePicker → server**: `localDatetimeToISO(local)` — converts the viewer's local wall clock back to a UTC ISO string.

```ts
import { toLocalDatetime, localDatetimeToISO } from '@/utils/format'

<DatePicker
  :model-value="toLocalDatetime(match.scheduled_at)"
  @update:model-value="save({ scheduled_at: localDatetimeToISO($event) })"
/>
```

**Never** do `iso.slice(0, 16)` to feed a DatePicker — it strips the `Z` and shows the UTC wall clock as if it were local, which is wrong for any viewer not in UTC.

For displaying timestamps, use `formatMatchDate(iso, t)` / `fmtDateTime(new Date(iso))` from `src/utils/format.ts`. These already interpret the ISO string as UTC and render in the viewer's local time.

## i18n Rules

When adding UI text, always add translations to all three locale files:
- `src/i18n/en.ts` (English)
- `src/i18n/lv.ts` (Latvian)
- `src/i18n/lt.ts` (Lithuanian)

## UI Dialogs

**Never use `window.prompt()`, `window.alert()`, or `window.confirm()` for any user-facing flow.** They look like browser chrome, can't be styled, don't translate, can't be tested cleanly, and feel out-of-place against the rest of the app.

Use the shared `<ModalOverlay>` component (`src/components/common/ModalOverlay.vue`) plus a `<card>` body. Examples to copy from: the Edit User modal in `AdminUsersPage.vue`, the Ban modal in `AdminQueuePage.vue`, the Link Discord modal in `AdminUsersPage.vue`.

For inline confirmations (e.g. "Are you sure you want to delete X?") still build a proper modal — `confirm()` is a `prompt()` in disguise and the same rule applies.

## Admin Page Layout

**Every page under `src/pages/admin/*.vue` MUST use the same root wrapper and header structure.** This avoids the slightly-different padding / max-width / heading sizes that are visible when navigating between admin sections.

### Canonical wrapper

```vue
<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <!-- Header: title + optional subtitle on the left, actions on the right -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('pageTitle') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('pageSubtitle') }}</p>
      </div>
      <button class="btn-primary text-sm" @click="...">...</button>
    </div>

    <!-- Cards / sections -->
    <div class="card">...</div>
  </div>
</template>
```

### Rules

- Wrapper classes are exactly `p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full`. Do NOT use `mx-auto`, `p-6`, or fixed gap values — the responsive padding/gap pair is the canonical mobile→desktop scale. Do NOT hardcode the max-width; use the CSS variable so the user's drag-resize preference applies.
- Title is `<h1 class="text-2xl font-semibold text-foreground">` with optional subtitle `<p class="text-sm text-muted-foreground mt-1">`. Do not use `text-xl` or icon-prefixed titles unless they're already established in the section.
- Inter-section spacing is owned by the wrapper's `gap-4 md:gap-6` — child sections should NOT add their own top/bottom margins.

### Reference pages

`AdminUsersPage.vue`, `AdminCompetitionsPage.vue`, `AdminNewsPage.vue`, `AdminBotsPage.vue`, `AdminQueuePage.vue`, `AdminPermissionsPage.vue`, `AdminSiteSettingsPage.vue`, `AdminCompetitionSetupPage.vue` already follow this pattern — copy from any of them when adding a new admin page.

## Lobby Settings

Per-competition lobby (Dota 2 in-game lobby) configuration. Stored as JSONB on `competitions.settings`, defaulted in `parseCompSettings()` (`server/helpers/competition.js`), edited in the **Lobby** tab of `AdminCompetitionSetupPage.vue`, and consumed by `botPool.createLobby()` (`server/services/botPool.js`) which forwards them to the Go bot service (`lobbybot/`). The queue path uses parallel column-based settings on `queue_pools` (`lobby_*` columns), edited in `AdminQueuePage.vue` and consumed by `botPool.createQueueLobby()` / `_buildGoLobbyPayload()` — same semantics, different storage. Both UIs must offer the same option values for every option-based key below; the int stored in the DB is sent verbatim to the Go bot, so divergent labels create real broadcast/series mismatches.

### Option-based settings (confirm each value)

| Key | Default | Options |
| --- | --- | --- |
| `lobbyGameMode` | `2` (CM) | `1` AP · `2` CM · `3` RD · `4` SD · `5` AR · `8` Reverse CM · `11` MO · `12` LP · `16` CD · `18` ABD · `20` ARDM · `21` 1v1 · `22` AD · `23` Turbo |
| `lobbyServerRegion` | `3` (EU West) | `0` US West · `1` US East · `3` EU West · `5` SE Asia · `7` Australia · `8` EU East · `9` S. America · `10` Russia |
| `lobbyDotaTvDelay` | `1` (10 min) | `0` None · `1` 10 min · `2` 5 min · `3` 2 min |
| `lobbySelectionPriority` | `0` (Manual) | `0` Manual · `1` Automatic |
| `lobbyCmPick` | `0` (Random) | `0` Random · `1` Radiant · `2` Dire — only applied when `lobbySelectionPriority === 0` |
| `lobbyPauseSetting` | `0` (Unlimited) | `0` Unlimited · `1` Limited · `2` Disabled |
| `lobbySeriesType` | `0` (None) | `0` None · `1` Bo2 · `2` Bo3 · `3` Bo5 |
| `lobbyPenaltyRadiant` | `0` (None) | `0` None · `1` Level 1 · `2` Level 2 · `3` Level 3 — pick-phase time penalty level. Per-match override: `matches.penalty_radiant` |
| `lobbyPenaltyDire` | `0` (None) | `0` None · `1` Level 1 · `2` Level 2 · `3` Level 3 — pick-phase time penalty level. Per-match override: `matches.penalty_dire` |

### Boolean settings

| Key | Default |
| --- | --- |
| `lobbyAutoAssignTeams` | `true` |
| `lobbyAllowSpectating` | `true` |
| `lobbyCheats` | `false` |

### Numeric settings

| Key | Default | Notes |
| --- | --- | --- |
| `lobbyTimeoutMinutes` | `10` | How long the bot waits for all expected players before erroring out |

### League selection (`lobbyLeagueId`)

Stored as a raw `dota_league_id` integer (default `0` = no league). The UI is a dropdown — **never a free-form number input** — sourced from `GET /api/leagues`.

- Backing table: `leagues` (`id`, `name`, `dota_league_id` UNIQUE, `public`, `created_by`, `created_at`). The unique constraint on `dota_league_id` prevents one user impersonating another by claiming the same Valve-issued id under a different name; create/update returns 409 on conflict.
- Visibility (`GET /api/leagues` — auth required):
  - Authenticated callers see all `public = TRUE` rows (the "anyone making a tournament can pick this" set) **plus** their own private rows.
  - `manage_leagues` (or `is_admin`) sees every row.
  - Page-level perms on `AdminCompetitionSetupPage` and `AdminQueuePage` already gate who reaches the dropdown, so this endpoint just requires login.
- Routes: `server/routes/leagues.js` — `GET` is public-readable per the rules above; `POST` requires `manage_leagues` or `manage_own_leagues`; `PUT` / `DELETE` use `requireLeaguePermission(req, res, leagueId)` (full perm OR creator with `manage_own_leagues`), mirroring `requireCompPermission`.
- Permissions: `manage_leagues` (full CRUD on every row), `manage_own_leagues` (CRUD only on rows you created). Both grant access to the **Leagues** sidebar entry / `/admin/leagues` page (`AdminLeaguesPage.vue`). The page exposes a Public toggle on add/edit and shows a Public/Private badge per row.
- The stored value is the raw `dota_league_id` — **not** an FK to `leagues.id` — so a league can be deleted from our table without breaking lobbies that reference its Valve-issued id. The dropdown preserves any unrecognised id with a `#NNNN` fallback option.
- Dropdown call sites: `AdminCompetitionSetupPage.vue` (Lobby tab) and `AdminQueuePage.vue` (queue pool form). Both load `api.getLeagues()` on mount; the visibility filter above means non-admin comp owners only see public leagues plus their own.

## Soft delete

Competitions use soft delete: `competitions.deleted_at TIMESTAMP NULL`. `DELETE /api/competitions/:id` flips `deleted_at = NOW()` and `is_featured = FALSE` (so the home-page featured slot frees up); the row and all cascaded children (captains, competition_players, matches, etc.) stay intact. Every read path filters `deleted_at IS NULL`:

- `getCompetition()` in `server/helpers/competition.js` (used by `requireCompPermission` and `botPool` lookups)
- `GET /api/competitions` and `GET /api/competitions/:id`
- `GET /api/home/stats` and `GET /api/home/featured-tournament`
- `GET /api/search` competition section
- `GET /api/players/:id` placements join

There is no admin "show deleted" view; restoring requires `UPDATE competitions SET deleted_at = NULL WHERE id = N` against the DB. Treat soft delete as a tombstone — don't leak deleted comps via new joins.

## Notifications

The in-app bell badge + the notifications tab in the Friends side panel. Two tables (`server/db.js`), served by `server/routes/notifications.js` (mounted via `createNotificationsRouter(io)`):

- `notifications (id, recipient_id NULL, type DEFAULT 'announcement', title, body NULL, link NULL, created_by NULL, created_at)` — **`recipient_id NULL` = broadcast** (every logged-in user sees it); **non-null = targeted** (only that player sees it).
- `notification_reads (notification_id, player_id, read_at, PK(notification_id, player_id))` — per-user read state, so one broadcast row serves everyone without duplication.

### Sending a notification to a player (targeted)

There is **no shared helper** — the canonical pattern is: insert a row with `recipient_id = <playerId>`, then emit `notification:new` to **only that player's** socket room (`user:${playerId}`, joined on connect) so their bell updates live. Copy `notifyFriendAccepted()` in `server/routes/friends.js`:

```js
const row = await queryOne(
  `INSERT INTO notifications (recipient_id, type, title, body, link, created_by)
   VALUES ($1, $2, $3, $4, $5, $6)
   RETURNING id`,
  [playerId, 'friend_accepted', `${name} accepted your friend request`, null, `/player/${actorId}`, actorId],
)
io?.to(`user:${playerId}`).emit('notification:new', { id: row.id })
```

- `type` is a free string for your own use (`friend_accepted`, `inhouse_strike_toxic`, `inhouse_strike_lifted`, …); the bell/badge logic ignores it.
- `title` is required; `body` and `link` are optional. `link` is the in-app path opened on click (e.g. `/queue`, `/player/123`).
- `created_by` records who triggered it but is **never exposed** to the recipient (`GET /api/notifications` doesn't select it) — so don't reveal sensitive "who reported you" info there; put player-facing detail in `body`.
- **Inside a transaction?** Insert the row within the txn, but emit `notification:new` **after COMMIT** — the client refetches on the event and the row must already be visible. See `_insertStrikeNotification()` + the post-commit emit in `server/routes/inhouseReports.js`.

### Broadcasting to everyone

`POST /api/admin/notifications {title, body?, link?}` (admin or `manage_notifications`) inserts a `recipient_id NULL` row and `io.emit('notification:new', { id })` to all sockets. Composer/history UI: `/admin/announcements`.

### Read state & badge

- `GET /api/notifications` → `{ rows, unread }` (broadcasts + my targeted rows joined with my reads). `POST /api/notifications/:id/read` and `POST /api/notifications/read-all` insert into `notification_reads` (`ON CONFLICT DO NOTHING`).
- `/api/auth/me` (and `PUT /me`) ship an `unread_notifications` count for the initial badge.
- Frontend: `useNotificationStore` (`loadAll`, `markRead`, `markAllRead`, `unreadCount`) refetches on `notification:new` / `notification:removed`; the bell badge binds to `notifStore.unreadCount`.

### Socket events

- `notification:new { id }` — server→client. Broadcast via `io.emit` (announcements) or targeted via `io.to(\`user:${id}\`)` (per-player). The client just refetches `GET /api/notifications`.
- `notification:removed { id }` — server→client, emitted by `DELETE /api/admin/notifications/:id`.

Per the API Documentation Rules above, a new notification **route** needs an `openapi.json` update and a new/changed **socket event** needs `asyncapi.json` — but simply *sending* a notification from existing code (insert + `notification:new`) needs neither.

## Stack

- **Frontend**: Vue 3 + TypeScript + Tailwind CSS + Vue I18n
- **Backend**: Express + Socket.io + PostgreSQL (via `pg` pool)
- **Auth**: Steam OpenID 2.0, in-memory session tokens
- **Real-time**: Socket.io with per-competition rooms (`comp:${compId}`)
- **Dev**: Docker Compose (draft-dev-app + draft-dev-db)
- **Prod**: Docker Compose with Traefik reverse proxy
- **Deploy**: Auto-deploy on push to `main` via GitHub Actions (`.github/workflows/deploy.yml`). SSHs into prod, pulls, rebuilds all containers. No manual deploy steps needed.

## Key Patterns

- Competition-scoped data uses `competition_players` join table, not global `players`
- Socket events broadcast to `comp:${compId}` rooms
- Admin permissions checked via `requirePermission()` / `requireCompPermission()`
- Auction state stored as JSONB in `competitions.auction_state`
- Settings stored as JSONB in `competitions.settings` with defaults in `parseCompSettings()`
