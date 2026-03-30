import type { UserProfile, VideoInfo, PlayerState } from './types.js'
import type WebSocket from 'ws'

export interface Room {
  id: string
  hostSocketId: string
  videoInfo: VideoInfo
  hostProfile: UserProfile
  users: Map<string, UserProfile> // socketId → profile (viewers only)
  playerState: PlayerState
}

const rooms = new Map<string, Room>()
// socketId → roomId (for cleanup on disconnect)
const socketRooms = new Map<string, string>()

function genId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

export function createRoom(
  socketId: string,
  profile: UserProfile,
  videoInfo: VideoInfo
): Room {
  let id = genId()
  while (rooms.has(id)) id = genId()

  const room: Room = {
    id,
    hostSocketId: socketId,
    videoInfo,
    hostProfile: profile,
    users: new Map(),
    playerState: { position: 0, isPaused: true, updatedAt: Date.now() }
  }
  rooms.set(id, room)
  socketRooms.set(socketId, id)
  return room
}

export function joinRoom(
  socketId: string,
  roomId: string,
  profile: UserProfile
): Room | null {
  const room = rooms.get(roomId)
  if (!room) return null
  room.users.set(socketId, profile)
  socketRooms.set(socketId, roomId)
  return room
}

export function leaveRoom(socketId: string): { room: Room; wasHost: boolean } | null {
  const roomId = socketRooms.get(socketId)
  if (!roomId) return null
  const room = rooms.get(roomId)
  if (!room) return null

  socketRooms.delete(socketId)
  const wasHost = room.hostSocketId === socketId

  if (wasHost) {
    // Remove all users from index and destroy room
    for (const uid of room.users.keys()) socketRooms.delete(uid)
    rooms.delete(roomId)
  } else {
    room.users.delete(socketId)
  }

  return { room, wasHost }
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId)
}

export function getRoomBySocket(socketId: string): Room | undefined {
  const roomId = socketRooms.get(socketId)
  return roomId ? rooms.get(roomId) : undefined
}

export function updatePlayerState(
  roomId: string,
  state: Partial<PlayerState>
): void {
  const room = rooms.get(roomId)
  if (!room) return
  Object.assign(room.playerState, state, { updatedAt: Date.now() })
}

export function usersInRoom(room: Room): WebSocket[] {
  // This is used externally — we return socketIds, the caller maps to ws
  return []
}
