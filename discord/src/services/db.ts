import pg from 'pg'
import { env } from '../env.js'
import { Logger } from './logger.js'

const pool = new pg.Pool({ connectionString: env.DATABASE_URL })

pool.on('error', (err) => {
  Logger.error(`[pg.Pool] idle client error: ${(err as any).code ?? ''} ${err.message}`)
})

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(sql, params)
  return rows as T[]
}

export async function queryOne<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const { rows } = await pool.query(sql, params)
  return (rows[0] as T) ?? null
}

export async function execute(sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  return pool.query(sql, params)
}

export async function ping(): Promise<void> {
  await pool.query('SELECT 1')
}

export function getPool(): pg.Pool {
  return pool
}
