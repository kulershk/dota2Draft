// A fetch_match_stats job carries the Dota match id it was enqueued for. If the
// game's dotabuff_id has since changed (relaunch after an aborted start) or been
// cleared, the job is chasing a match that was never played — stop it.
export function statsJobSuperseded(game, dotabuffId) {
  return String(game?.dotabuff_id || '') !== String(dotabuffId || '')
}
