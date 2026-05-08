// Registry of server-pushed events the bot fans out to plugins. The transport
// is a single endpoint (POST /internal/event in internal-server.ts) that
// re-emits via `client.emit(type, payload)`. Plugins consume them with the
// usual `@EventHook` method-name convention:
//
//   @EventHook()
//   async onMatchStarted(payload: MatchStartedPayload) { ... }
//
// Adding a new event is two lines:
//   1) Add a string under DRAFT_EVENTS below + define its payload interface.
//   2) Server side: `discordBot.emit('myEvent', payload)`.
// No bot endpoint to add. No PluginManager change. The plugin gating
// (discord_plugin_<name>_enabled) applies automatically.

export const DRAFT_EVENTS = {
  /** Fired after a queue match's lobby is created and the team rosters are
   *  finalized. Payload mirrors what the bot's match-voice service receives
   *  on /internal/match/start. */
  MATCH_STARTED: 'matchStarted',
  /** Fired when a queue match either finishes (botPool auto-fill) or is
   *  cancelled (immediate=true). Payload is minimal — plugins can re-query
   *  the DB by matchId for richer data. */
  MATCH_ENDED: 'matchEnded',
  /** Admin-triggered tournament announce (POST /api/competitions/:id/discord-announce). */
  TOURNAMENT_ANNOUNCE: 'tournamentAnnounce',
} as const

export type DraftEventName = (typeof DRAFT_EVENTS)[keyof typeof DRAFT_EVENTS]

// ─── Payload shapes ─────────────────────────────────────────────────────

export interface MatchTeamSpec {
  side: 'radiant' | 'dire'
  captainName?: string
  playerIds: number[]
}

export interface MatchStartedPayload {
  matchId: number
  queueMatchId?: number | null
  team1: MatchTeamSpec
  team2: MatchTeamSpec
}

export interface MatchEndedPayload {
  matchId: number
  /** True when the match ended via cancellation — voice cleanup runs without
   *  the configured delay. */
  immediate?: boolean
}

export interface TournamentAnnouncePayload {
  id: number
  name: string
  description?: string | null
  startsAt?: string | null
  registrationStart?: string | null
  registrationEnd?: string | null
  competitionType?: string | null
  bannerUrl?: string | null
  publicUrl?: string | null
}
