import pg from 'pg'

export async function setup() {
  const baseUrl = process.env.DATABASE_URL || 'postgresql://draft:draft@localhost:5432/draft'
  const parsed = new URL(baseUrl)
  const testDbName = 'draft_test'

  const client = new pg.Client({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    user: parsed.username,
    password: parsed.password,
    database: 'postgres',
  })

  try {
    await client.connect()
    const res = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [testDbName])
    if (res.rows.length === 0) {
      await client.query(`CREATE DATABASE ${testDbName} OWNER ${parsed.username}`)
      console.log(`Created test database: ${testDbName}`)
    }
  } catch (e) {
    if (!e.message?.includes('already exists')) {
      console.error('Failed to create test database:', e.message)
    }
  } finally {
    await client.end()
  }
}
