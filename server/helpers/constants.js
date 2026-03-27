// Match statuses
export const MATCH_STATUS = {
  PENDING: 'pending',
  LIVE: 'live',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
}

// Competition statuses
export const COMP_STATUS = {
  DRAFT: 'draft',
  REGISTRATION: 'registration',
  REGISTRATION_CLOSED: 'registration_closed',
  ACTIVE: 'active',
  FINISHED: 'finished',
}

// Auction statuses
export const AUCTION_STATUS = {
  IDLE: 'idle',
  NOMINATING: 'nominating',
  BIDDING: 'bidding',
  PAUSED: 'paused',
  FINISHED: 'finished',
}

// Lobby statuses
export const LOBBY_STATUS = {
  CREATING: 'creating',
  WAITING: 'waiting',
  ACTIVE: 'active',
  LAUNCHING: 'launching',
  COMPLETED: 'completed',
  ERROR: 'error',
  CANCELLED: 'cancelled',
}

// Fantasy stage statuses
export const FANTASY_STATUS = {
  UPCOMING: 'upcoming',
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETED: 'completed',
}
