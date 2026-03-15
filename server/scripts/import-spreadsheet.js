import { query, queryOne, execute, initDb } from '../db.js'
import { fetchSteamProfile, resolveVanityUrl } from '../helpers/steam.js'

// MMR values are (MMR)sez from the spreadsheet
const PLAYERS = [
  { name: 'Ri4man', mmr: 14000, steam: 'https://steamcommunity.com/profiles/76561198349171077/', scores: [5,5,1,1,1] },
  { name: 'Volten', mmr: 10600, steam: 'https://steamcommunity.com/profiles/76561198055917301/', scores: [5,4,4,4,4] },
  { name: 'Jozzyks', mmr: 9700, steam: 'https://steamcommunity.com/profiles/76561198109734771/', scores: [4,5,4,3,1] },
  { name: 'Ingman', mmr: 9300, steam: 'https://steamcommunity.com/profiles/76561198080376851/', scores: [5,4,4,1,1] },
  { name: 'Yorlak', mmr: 9200, steam: 'https://steamcommunity.com/profiles/76561198806317610/', scores: [3,1,5,2,1] },
  { name: 'hellq', mmr: 9200, steam: 'https://steamcommunity.com/profiles/76561198214655149/', scores: [4,5,4,4,4] },
  { name: 'xen', mmr: 8800, steam: 'https://steamcommunity.com/profiles/76561198064558833/', scores: [2,5,4,5,5] },
  { name: 'nukeloff', mmr: 8500, steam: 'https://steamcommunity.com/id/nukeloff69/', scores: [5,1,1,1,1] },
  { name: 'Teelo', mmr: 8700, steam: 'https://steamcommunity.com/id/teeloisawesome/', scores: [2,2,2,5,5] },
  { name: 'Ene', mmr: 7800, steam: 'https://steamcommunity.com/id/morfikk1/', scores: [5,1,1,1,1] },
  { name: 'Call me steve', mmr: 7600, steam: 'https://steamcommunity.com/profiles/76561198319791618', scores: [5,3,4,4,4] },
  { name: 'JII', mmr: 7600, steam: 'https://steamcommunity.com/id/jegorov28/', scores: [1,1,1,5,1] },
  { name: 'ralfyk', mmr: 7400, steam: 'https://steamcommunity.com/profiles/76561199239905057/', scores: [1,1,5,1,1] },
  { name: 'ewok', mmr: 7300, steam: 'https://steamcommunity.com/id/ewokrocks/', scores: [1,5,1,1,1] },
  { name: 'Pianists', mmr: 7300, steam: 'https://steamcommunity.com/id/ESPANHARD/', scores: [4,5,1,1,1] },
  { name: 'Necro', mmr: 7100, steam: 'https://steamcommunity.com/id/Necrobiosys/', scores: [1,4,3,5,1] },
  { name: 'Rapdis', mmr: 7000, steam: 'https://steamcommunity.com/id/1010102323232/', scores: [1,4,1,5,2] },
  { name: 'LMK', mmr: 7000, steam: 'https://steamcommunity.com/id/LMKisBACK/', scores: [4,4,4,3,1] },
  { name: 'ulaf', mmr: 7000, steam: 'https://steamcommunity.com/id/ulafzs/', scores: [5,5,5,2,1] },
  { name: 'Krūtinė', mmr: 7000, steam: 'https://steamcommunity.com/id/20431097/', scores: [3,1,4,5,5] },
  { name: 'Dr.Zaiks', mmr: 6800, steam: 'https://steamcommunity.com/profiles/76561198057467761/', scores: [4,1,5,3,3] },
  { name: 'saibers', mmr: 6800, steam: 'https://steamcommunity.com/id/saibers1337/', scores: [3,5,4,5,5] },
  { name: 'Nanashizxc', mmr: 6800, steam: 'https://steamcommunity.com/profiles/76561198207716459/', scores: [3,5,1,1,1] },
  { name: 'Seino', mmr: 6800, steam: 'https://steamcommunity.com/id/Seino/', scores: [4,5,1,1,1] },
  { name: 'Valchers', mmr: 6800, steam: 'https://steamcommunity.com/id/Valchers/', scores: [5,3,2,1,1] },
  { name: 'Ed', mmr: 6700, steam: 'https://steamcommunity.com/id/KekWaitSaid/', scores: [1,1,1,5,5] },
  { name: 'Korii', mmr: 6700, steam: 'https://steamcommunity.com/id/edvards99888/', scores: [1,1,5,3,1] },
  { name: 'Dizepower', mmr: 6400, steam: 'https://steamcommunity.com/id/dizepower/', scores: [5,4,5,3,1] },
  { name: 'HESOIJAM', mmr: 6400, steam: 'https://steamcommunity.com/id/hesoijam/', scores: [1,1,3,5,4] },
  { name: 'OBI', mmr: 6300, steam: 'https://steamcommunity.com/profiles/76561198160903407/', scores: [1,5,1,1,1] },
  { name: 'Cukurpaps', mmr: 6100, steam: 'https://steamcommunity.com/id/69cukurpaps69/', scores: [5,1,1,1,1] },
  { name: 'uNstabliņš', mmr: 5800, steam: 'https://steamcommunity.com/profiles/76561198063180421/', scores: [4,5,1,4,4] },
  { name: 'Notdexii/Dexii', mmr: 5700, steam: 'https://steamcommunity.com/id/Dexechii/', scores: [1,1,2,5,5] },
  { name: 'Najsik', mmr: 5600, steam: 'https://steamcommunity.com/id/vladisl0v3/', scores: [3,5,3,1,3] },
  { name: 'KornsInPairs', mmr: 5500, steam: 'https://steamcommunity.com/id/KornsInParis/', scores: [3,1,5,5,5] },
  { name: 'Teacher_Bauer', mmr: 5500, steam: 'https://steamcommunity.com/profiles/76561198149421062/', scores: [1,1,1,1,5] },
  { name: 'Hape', mmr: 5200, steam: 'https://steamcommunity.com/id/Hapeeeee/', scores: [5,1,4,2,3] },
  { name: 'Tudigong', mmr: 5200, steam: 'https://steamcommunity.com/profiles/76561198087378132/', scores: [4,1,5,1,1] },
  { name: 'AldisWD', mmr: 4800, steam: 'https://steamcommunity.com/id/chubrx_was_here/', scores: [4,5,3,3,1] },
  { name: 'kulers', mmr: 4700, steam: 'https://steamcommunity.com/id/kulers/', scores: [1,1,2,5,4] },
  { name: 'Jenny Talia', mmr: 4700, steam: 'http://steamcommunity.com/id/blackjack2025/', scores: [1,1,2,5,5] },
  { name: 'Escanor', mmr: 4700, steam: 'https://steamcommunity.com/profiles/76561198042887680/', scores: [1,1,5,5,5] },
  { name: 'RĪGARĒZEKNE', mmr: 4600, steam: 'https://steamcommunity.com/id/w1cc/', scores: [5,3,2,4,4] },
  { name: 'Brens', mmr: 4500, steam: 'https://steamcommunity.com/profiles/76561198875641022/', scores: [5,3,3,2,2] },
  { name: 'Kitagawa', mmr: 4400, steam: 'https://steamcommunity.com/id/Kitagawa_/', scores: [5,4,3,1,1] },
  { name: 'MilkyWay', mmr: 4400, steam: 'https://steamcommunity.com/profiles/76561198140378665/', scores: [1,3,5,5,4] },
  { name: 'Stron1k', mmr: 4300, steam: 'https://steamcommunity.com/id/stronik/', scores: [5,0,0,0,0] },
  { name: 'NoName', mmr: 4100, steam: 'https://steamcommunity.com/profiles/76561198076474813/', scores: [3,4,3,5,3] },
  { name: 'L1n1Z', mmr: 4100, steam: 'https://steamcommunity.com/profiles/76561198096547103/', scores: [2,5,4,4,4] },
  { name: 'Juno', mmr: 4000, steam: 'https://steamcommunity.com/id/sailorjuno/', scores: [1,1,1,4,5] },
  { name: 'Kekums', mmr: 3800, steam: 'https://steamcommunity.com/id/kekumsolog/', scores: [4,2,2,3,5] },
  { name: 'BD-AMRY', mmr: 3800, steam: 'https://steamcommunity.com/profiles/76561198069408792/', scores: [3,4,3,5,5] },
  { name: 'Dentists', mmr: 3800, steam: 'https://steamcommunity.com/profiles/76561198047608755/', scores: [1,1,3,5,5] },
  { name: 'Newcolor77', mmr: 3700, steam: 'https://steamcommunity.com/profiles/76561199670890075/', scores: [2,1,2,4,5] },
  { name: 'qs', mmr: 3400, steam: 'https://steamcommunity.com/id/qasmokee/', scores: [3,3,1,5,3] },
  { name: 'Supros', mmr: 3300, steam: 'https://steamcommunity.com/profiles/76561198047705003/', scores: [2,1,3,5,5] },
  { name: 'rayray', mmr: 3200, steam: 'https://steamcommunity.com/profiles/76561198334232516/', scores: [4,2,4,4,4] },
  { name: 'skrubixx', mmr: 3100, steam: 'https://steamcommunity.com/id/skrubiz/', scores: [4,4,5,4,4] },
  { name: 'Roid', mmr: 2800, steam: 'https://steamcommunity.com/id/Roidur/', scores: [3,1,5,4,4] },
  { name: 'Unorthodox', mmr: 2700, steam: 'https://steamcommunity.com/profiles/76561198048223936/', scores: [2,1,4,5,4] },
  { name: 'surenxs', mmr: 2700, steam: 'https://steamcommunity.com/id/surenxs/', scores: [1,1,5,5,5] },
  { name: 'Snicis', mmr: 2500, steam: 'https://steamcommunity.com/profiles/76561198080109672', scores: [1,1,3,5,5] },
  { name: 'StockholmSyndrome', mmr: 2200, steam: 'https://steamcommunity.com/id/6y7u5tbg4ret563/', scores: [5,5,1,4,4] },
  { name: 'Grim', mmr: 2000, steam: 'https://steamcommunity.com/id/goodoldgrim', scores: [4,4,4,5,4] },
  { name: 'Rolciss', mmr: 2000, steam: 'https://steamcommunity.com/profiles/76561199202670294/', scores: [1,1,1,5,5] },
  { name: 'WindAspect', mmr: 2000, steam: 'https://steamcommunity.com/profiles/76561198011112176/', scores: [3,1,4,5,5] },
  { name: 'kuzjaa', mmr: 1900, steam: 'https://steamcommunity.com/profiles/76561198884459685/', scores: [4,4,3,5,5] },
  { name: 'Mikjelsone', mmr: 1600, steam: 'https://steamcommunity.com/profiles/76561198066286765/', scores: [1,1,1,5,5] },
  { name: 'braziltokyo', mmr: 500, steam: 'https://steamcommunity.com/profiles/76561199674832820/', scores: [5,5,1,3,1] },
  { name: 'Savage', mmr: 500, steam: 'https://steamcommunity.com/profiles/76561198316731412/', scores: [1,1,3,5,5] },
  { name: 'Achimari', mmr: 4792, steam: 'https://steamcommunity.com/profiles/76561199090642151/', scores: [2,1,3,5,4] },
]

const ROLE_NAMES = ['Carry', 'Mid', 'Offlane', 'Pos4', 'Pos5']

function scoresToRoles(scores) {
  const roles = []
  for (let i = 0; i < 5; i++) {
    if (scores[i] >= 4) roles.push(ROLE_NAMES[i])
  }
  // If no role scored >= 4, take the highest
  if (roles.length === 0) {
    const max = Math.max(...scores)
    if (max > 0) {
      for (let i = 0; i < 5; i++) {
        if (scores[i] === max) roles.push(ROLE_NAMES[i])
      }
    }
  }
  return roles
}

async function extractSteamId(url) {
  const profileMatch = url.match(/\/profiles\/(\d+)/)
  if (profileMatch) return profileMatch[1]
  const vanityMatch = url.match(/\/id\/([^\/\s?#]+)/)
  if (vanityMatch) {
    const resolved = await resolveVanityUrl(vanityMatch[1])
    return resolved
  }
  return null
}

async function main() {
  await initDb()
  console.log(`Processing ${PLAYERS.length} players...`)

  let created = 0, updated = 0, failed = 0

  for (const p of PLAYERS) {
    const steamId = await extractSteamId(p.steam)
    if (!steamId) {
      console.log(`  SKIP ${p.name} - could not resolve Steam ID from ${p.steam}`)
      failed++
      continue
    }

    const roles = scoresToRoles(p.scores)
    const rolesJson = JSON.stringify(roles)

    let player = await queryOne('SELECT id, name FROM players WHERE steam_id = $1', [steamId])
    if (player) {
      await execute('UPDATE players SET mmr = $1, roles = $2 WHERE id = $3', [p.mmr, rolesJson, player.id])
      console.log(`  UPDATE ${player.name} (id=${player.id}): mmr=${p.mmr}, roles=${roles.join(',')}`)
      updated++
    } else {
      const { personaName, avatarUrl } = await fetchSteamProfile(steamId)
      player = await queryOne(
        'INSERT INTO players (name, steam_id, avatar_url, mmr, roles) VALUES ($1, $2, $3, $4, $5) RETURNING id, name',
        [personaName, steamId, avatarUrl, p.mmr, rolesJson]
      )
      console.log(`  CREATE ${player.name} (id=${player.id}): mmr=${p.mmr}, roles=${roles.join(',')}`)
      created++
    }
  }

  console.log(`\nDone! Created: ${created}, Updated: ${updated}, Failed: ${failed}`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
