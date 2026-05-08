import { env } from '../env.js'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${env.API_BASE_URL}${path}`
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`API ${path} responded ${res.status}`)
  return res.json() as Promise<T>
}

export const Api = {
  homeStats: () => request<Record<string, unknown>>('/api/home/stats'),
  // Add more typed wrappers here as bot needs them.
}
