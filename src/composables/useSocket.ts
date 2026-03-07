import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'

let socket: Socket | null = null
let serverTimeOffset = 0

export function getSocket(): Socket {
  if (!socket) {
    socket = io()
    // Sync time with server
    socket.on('server:time', (serverTime: number) => {
      serverTimeOffset = serverTime - Date.now()
    })
    socket.on('connect', () => {
      socket!.emit('server:ping')
    })
  }
  return socket
}

export function getServerNow(): number {
  return Date.now() + serverTimeOffset
}

export function useSocket() {
  const sock = getSocket()
  return sock
}
