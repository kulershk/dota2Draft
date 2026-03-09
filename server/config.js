import crypto from 'crypto'

export const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex')
export const JWT_EXPIRY = '30d'
export const BASE_URL = process.env.BASE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173')
export const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || ''
export const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || ''
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || ''
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || ''
export const DOTA2_GAME_ID = '29595'
