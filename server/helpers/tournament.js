import { query, queryOne, execute } from '../db.js'

export async function advanceWinner(matchId, winnerId) {
  const match = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
  if (!match) return

  if (match.next_match_id) {
    const col = match.next_match_slot === 1 ? 'team1_captain_id' : 'team2_captain_id'
    await execute(`UPDATE matches SET ${col} = $1 WHERE id = $2`, [winnerId, match.next_match_id])
  }

  if (match.loser_next_match_id) {
    const loserId = match.team1_captain_id === winnerId ? match.team2_captain_id : match.team1_captain_id
    if (loserId) {
      const col = match.loser_next_match_slot === 1 ? 'team1_captain_id' : 'team2_captain_id'
      await execute(`UPDATE matches SET ${col} = $1 WHERE id = $2`, [loserId, match.loser_next_match_id])
    }
  }
}

export async function generateEliminationBracket(compId, stageId, teamIds, bestOf) {
  const n = teamIds.length
  let bracketSize = 1
  while (bracketSize < n) bracketSize *= 2
  const totalRounds = Math.log2(bracketSize)

  const matchesByRound = {}
  for (let round = totalRounds; round >= 1; round--) {
    const matchCount = bracketSize / Math.pow(2, round)
    matchesByRound[round] = []
    for (let i = 0; i < matchCount; i++) {
      const m = await queryOne(
        `INSERT INTO matches (competition_id, stage, round, match_order, best_of, status)
         VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
        [compId, stageId, round, i, bestOf]
      )
      matchesByRound[round].push(m.id)
    }
  }

  for (let round = 1; round < totalRounds; round++) {
    const ids = matchesByRound[round]
    for (let i = 0; i < ids.length; i++) {
      const nextMatchId = matchesByRound[round + 1][Math.floor(i / 2)]
      const nextSlot = (i % 2) + 1
      await execute('UPDATE matches SET next_match_id = $1, next_match_slot = $2 WHERE id = $3',
        [nextMatchId, nextSlot, ids[i]])
    }
  }

  const round1 = matchesByRound[1]
  for (let i = 0; i < bracketSize; i++) {
    const captainId = i < n ? teamIds[i] : null
    const matchIdx = Math.floor(i / 2)
    const slot = (i % 2) + 1
    if (captainId) {
      const col = slot === 1 ? 'team1_captain_id' : 'team2_captain_id'
      await execute(`UPDATE matches SET ${col} = $1 WHERE id = $2`, [captainId, round1[matchIdx]])
    }
  }

  for (const matchId of round1) {
    const m = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
    if (m.team1_captain_id && !m.team2_captain_id) {
      await execute("UPDATE matches SET winner_captain_id = $1, status = 'completed', score1 = 1, score2 = 0 WHERE id = $2",
        [m.team1_captain_id, matchId])
      await advanceWinner(matchId, m.team1_captain_id)
    } else if (!m.team1_captain_id && m.team2_captain_id) {
      await execute("UPDATE matches SET winner_captain_id = $1, status = 'completed', score1 = 0, score2 = 1 WHERE id = $2",
        [m.team2_captain_id, matchId])
      await advanceWinner(matchId, m.team2_captain_id)
    }
  }

  return { bracketSize, totalRounds }
}

export async function generateGroupMatches(compId, stageId, groups, bestOf) {
  for (const group of groups) {
    const teamIds = group.teamIds
    let order = 0
    for (let i = 0; i < teamIds.length; i++) {
      for (let j = i + 1; j < teamIds.length; j++) {
        await execute(
          `INSERT INTO matches (competition_id, stage, round, match_order, group_name, team1_captain_id, team2_captain_id, best_of, status)
           VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'pending')`,
          [compId, stageId, order++, group.name, teamIds[i], teamIds[j], bestOf]
        )
      }
    }
  }
}

export async function generateDoubleEliminationBracket(compId, stageId, teamIds, bestOf) {
  const n = teamIds.length
  let bracketSize = 1
  while (bracketSize < n) bracketSize *= 2
  const ubRounds = Math.log2(bracketSize)

  const ubByRound = {}
  for (let round = ubRounds; round >= 1; round--) {
    const matchCount = bracketSize / Math.pow(2, round)
    ubByRound[round] = []
    for (let i = 0; i < matchCount; i++) {
      const m = await queryOne(
        `INSERT INTO matches (competition_id, stage, round, match_order, best_of, status, bracket)
         VALUES ($1, $2, $3, $4, $5, 'pending', 'upper') RETURNING id`,
        [compId, stageId, round, i, bestOf]
      )
      ubByRound[round].push(m.id)
    }
  }

  for (let round = 1; round < ubRounds; round++) {
    const ids = ubByRound[round]
    for (let i = 0; i < ids.length; i++) {
      const nextMatchId = ubByRound[round + 1][Math.floor(i / 2)]
      const nextSlot = (i % 2) + 1
      await execute('UPDATE matches SET next_match_id = $1, next_match_slot = $2 WHERE id = $3',
        [nextMatchId, nextSlot, ids[i]])
    }
  }

  const lbTotalRounds = Math.max((ubRounds - 1) * 2, 1)
  const lbByRound = {}

  let lbMatchCount = bracketSize / 4
  const lbMatchCounts = {}
  for (let lr = 1; lr <= lbTotalRounds; lr++) {
    lbMatchCounts[lr] = Math.max(lbMatchCount, 1)
    if (lr % 2 === 0) {
      lbMatchCount = Math.max(Math.floor(lbMatchCount / 2), 1)
    }
  }

  for (let lr = 1; lr <= lbTotalRounds; lr++) {
    lbByRound[lr] = []
    for (let i = 0; i < lbMatchCounts[lr]; i++) {
      const m = await queryOne(
        `INSERT INTO matches (competition_id, stage, round, match_order, best_of, status, bracket)
         VALUES ($1, $2, $3, $4, $5, 'pending', 'lower') RETURNING id`,
        [compId, stageId, 100 + lr, i, bestOf]
      )
      lbByRound[lr].push(m.id)
    }
  }

  for (let lr = 1; lr < lbTotalRounds; lr++) {
    const ids = lbByRound[lr]
    const nextIds = lbByRound[lr + 1]
    for (let i = 0; i < ids.length; i++) {
      let nextIdx, nextSlot
      if (lr % 2 === 1) {
        nextIdx = i
        nextSlot = 1
      } else {
        nextIdx = Math.floor(i / 2)
        nextSlot = (i % 2) + 1
      }
      if (nextIdx < nextIds.length) {
        await execute('UPDATE matches SET next_match_id = $1, next_match_slot = $2 WHERE id = $3',
          [nextIds[nextIdx], nextSlot, ids[i]])
      }
    }
  }

  if (ubByRound[1]) {
    const ubR1 = ubByRound[1]
    for (let i = 0; i < ubR1.length; i++) {
      const lbIdx = Math.floor(i / 2)
      const lbSlot = (i % 2) + 1
      if (lbByRound[1] && lbIdx < lbByRound[1].length) {
        await execute('UPDATE matches SET loser_next_match_id = $1, loser_next_match_slot = $2 WHERE id = $3',
          [lbByRound[1][lbIdx], lbSlot, ubR1[i]])
      }
    }
  }

  for (let ubr = 2; ubr <= ubRounds; ubr++) {
    const lbTargetRound = (ubr - 1) * 2
    if (ubByRound[ubr] && lbByRound[lbTargetRound]) {
      const ubIds = ubByRound[ubr]
      const lbIds = lbByRound[lbTargetRound]
      for (let i = 0; i < ubIds.length && i < lbIds.length; i++) {
        await execute('UPDATE matches SET loser_next_match_id = $1, loser_next_match_slot = $2 WHERE id = $3',
          [lbIds[i], 2, ubIds[i]])
      }
    }
  }

  const gf = await queryOne(
    `INSERT INTO matches (competition_id, stage, round, match_order, best_of, status, bracket)
     VALUES ($1, $2, $3, 0, $4, 'pending', 'grand_finals') RETURNING id`,
    [compId, stageId, 200, bestOf]
  )

  const ubFinalId = ubByRound[ubRounds][0]
  await execute('UPDATE matches SET next_match_id = $1, next_match_slot = 1 WHERE id = $2', [gf.id, ubFinalId])

  const lbFinalId = lbByRound[lbTotalRounds][0]
  await execute('UPDATE matches SET next_match_id = $1, next_match_slot = 2 WHERE id = $2', [gf.id, lbFinalId])

  await execute('UPDATE matches SET loser_next_match_id = $1, loser_next_match_slot = 2 WHERE id = $2',
    [lbFinalId, ubFinalId])

  const round1 = ubByRound[1]
  for (let i = 0; i < bracketSize; i++) {
    const captainId = i < n ? teamIds[i] : null
    const matchIdx = Math.floor(i / 2)
    const slot = (i % 2) + 1
    if (captainId) {
      const col = slot === 1 ? 'team1_captain_id' : 'team2_captain_id'
      await execute(`UPDATE matches SET ${col} = $1 WHERE id = $2`, [captainId, round1[matchIdx]])
    }
  }

  for (const matchId of round1) {
    const m = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
    if (m.team1_captain_id && !m.team2_captain_id) {
      await execute("UPDATE matches SET winner_captain_id = $1, status = 'completed', score1 = 1, score2 = 0 WHERE id = $2",
        [m.team1_captain_id, matchId])
      await advanceWinner(matchId, m.team1_captain_id)
    } else if (!m.team1_captain_id && m.team2_captain_id) {
      await execute("UPDATE matches SET winner_captain_id = $1, status = 'completed', score1 = 0, score2 = 1 WHERE id = $2",
        [m.team2_captain_id, matchId])
      await advanceWinner(matchId, m.team2_captain_id)
    }
  }

  return { bracketSize, ubRounds, lbTotalRounds }
}
