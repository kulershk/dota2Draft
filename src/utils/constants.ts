// Match statuses
export const MATCH_STATUS = {
  PENDING: 'pending',
  LIVE: 'live',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const

// Competition statuses
export const COMP_STATUS = {
  DRAFT: 'draft',
  REGISTRATION: 'registration',
  ACTIVE: 'active',
  FINISHED: 'finished',
} as const

// Auction statuses
export const AUCTION_STATUS = {
  IDLE: 'idle',
  NOMINATING: 'nominating',
  BIDDING: 'bidding',
  PAUSED: 'paused',
  FINISHED: 'finished',
} as const

// Lobby statuses
export const LOBBY_STATUS = {
  CREATING: 'creating',
  WAITING: 'waiting',
  ACTIVE: 'active',
  LAUNCHING: 'launching',
  COMPLETED: 'completed',
  ERROR: 'error',
  CANCELLED: 'cancelled',
} as const

// Fantasy stage statuses
export const FANTASY_STATUS = {
  UPCOMING: 'upcoming',
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETED: 'completed',
} as const
