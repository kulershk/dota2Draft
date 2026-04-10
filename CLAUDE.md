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
