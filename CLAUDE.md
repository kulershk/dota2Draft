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

- Backing table: `leagues` (`id`, `name`, `dota_league_id`, `public`, `created_by`, `created_at`).
- Visibility (`GET /api/leagues` — auth required):
  - Authenticated callers see all `public = TRUE` rows (the "anyone making a tournament can pick this" set) **plus** their own private rows.
  - `manage_leagues` (or `is_admin`) sees every row.
  - Page-level perms on `AdminCompetitionSetupPage` and `AdminQueuePage` already gate who reaches the dropdown, so this endpoint just requires login.
- Routes: `server/routes/leagues.js` — `GET` is public-readable per the rules above; `POST` requires `manage_leagues` or `manage_own_leagues`; `PUT` / `DELETE` use `requireLeaguePermission(req, res, leagueId)` (full perm OR creator with `manage_own_leagues`), mirroring `requireCompPermission`.
- Permissions: `manage_leagues` (full CRUD on every row), `manage_own_leagues` (CRUD only on rows you created). Both grant access to the **Leagues** sidebar entry / `/admin/leagues` page (`AdminLeaguesPage.vue`). The page exposes a Public toggle on add/edit and shows a Public/Private badge per row.
- The stored value is the raw `dota_league_id` — **not** an FK to `leagues.id` — so a league can be deleted from our table without breaking lobbies that reference its Valve-issued id. The dropdown preserves any unrecognised id with a `#NNNN` fallback option.
- Dropdown call sites: `AdminCompetitionSetupPage.vue` (Lobby tab) and `AdminQueuePage.vue` (queue pool form). Both load `api.getLeagues()` on mount; the visibility filter above means non-admin comp owners only see public leagues plus their own.

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
