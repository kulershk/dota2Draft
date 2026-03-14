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

## Key Patterns

- Competition-scoped data uses `competition_players` join table, not global `players`
- Socket events broadcast to `comp:${compId}` rooms
- Admin permissions checked via `requirePermission()` / `requireCompPermission()`
- Auction state stored as JSONB in `competitions.auction_state`
- Settings stored as JSONB in `competitions.settings` with defaults in `parseCompSettings()`
