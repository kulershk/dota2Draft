import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io()
  }
  return socket
}

export function useSocket() {
  const sock = getSocket()
  return sock
}
