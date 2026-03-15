import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null
let serverTimeOffset = 0

export function getSocket(): Socket {
  if (!socket) {
    const token = localStorage.getItem('draft_auth_token') || ''
    socket = io({ auth: { token } })
    // Sync time with server
    socket.on('time:sync', (data: { serverTime: number }) => {
      serverTimeOffset = data.serverTime - Date.now()
    })
    socket.on('connect', () => {
      socket!.emit('time:sync')
    })
  }
  return socket
}

export function reconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
  return getSocket()
}

export function getServerNow(): number {
  return Date.now() + serverTimeOffset
}

export function useSocket() {
  const sock = getSocket()
  return sock
}
