import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  getRoomBySocket,
  updatePlayerState
} from './rooms.js'
import type { ClientMessage, ServerMessage } from './types.js'

const PORT = Number(process.env.PORT ?? 4242)

// ─── HTTP + WS server ─────────────────────────────────────────────────────────

const app = express()
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  next()
})
const server = createServer(app)
const wss = new WebSocketServer({ server })

// socketId → WebSocket
const sockets = new Map<string, WebSocket>()

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function sendToSocket(socketId: string, msg: ServerMessage): void {
  const ws = sockets.get(socketId)
  if (ws) send(ws, msg)
}

function broadcast(socketIds: Iterable<string>, msg: ServerMessage, exclude?: string): void {
  for (const id of socketIds) {
    if (id !== exclude) sendToSocket(id, msg)
  }
}

// ─── Pending HLS requests (relay → host → relay → viewer HTTP response) ───────

interface PendingHls {
  resolve: (data: Buffer | null) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingHls = new Map<string, PendingHls>()

// ─── WebSocket handlers ───────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  const socketId = randomUUID()
  sockets.set(socketId, ws)

  ws.on('message', (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage
    } catch {
      return
    }

    switch (msg.type) {
      case 'create-room': {
        const room = createRoom(socketId, msg.profile, msg.videoInfo)
        send(ws, { type: 'room-created', roomId: room.id })
        console.log(`[room] created ${room.id} by ${msg.profile.nickname}`)
        break
      }

      case 'join-room': {
        const room = joinRoom(socketId, msg.roomId, msg.profile)
        if (!room) {
          send(ws, { type: 'error', message: 'Комната не найдена' })
          return
        }
        // Notify existing users
        const allIds = [room.hostSocketId, ...room.users.keys()]
        broadcast(allIds, { type: 'user-joined', userId: socketId, profile: msg.profile }, socketId)
        // Send room state to joiner
        send(ws, {
          type: 'room-joined',
          roomId: room.id,
          videoInfo: room.videoInfo,
          hostProfile: room.hostProfile,
          users: Object.fromEntries(
            [...room.users.entries()].filter(([id]) => id !== socketId)
          ),
          playerState: room.playerState
        })
        console.log(`[room] ${msg.profile.nickname} joined ${room.id}`)
        break
      }

      case 'leave-room': {
        const result = leaveRoom(socketId)
        if (!result) return
        const { room, wasHost } = result
        if (wasHost) {
          // Notify all viewers the host left
          broadcast(room.users.keys(), { type: 'host-left' })
          console.log(`[room] host left ${room.id}, room destroyed`)
        } else {
          const allIds = [room.hostSocketId, ...room.users.keys()]
          broadcast(allIds, { type: 'user-left', userId: socketId })
          console.log(`[room] user left ${room.id}`)
        }
        break
      }

      case 'sync': {
        const room = getRoomBySocket(socketId)
        if (!room || room.hostSocketId !== socketId) return
        if (msg.action === 'play') updatePlayerState(room.id, { isPaused: false, position: msg.position })
        if (msg.action === 'pause') updatePlayerState(room.id, { isPaused: true, position: msg.position })
        if (msg.action === 'seek') updatePlayerState(room.id, { position: msg.position })
        // Broadcast to all viewers
        broadcast(room.users.keys(), { type: 'sync', action: msg.action, position: msg.position, ts: msg.ts })
        break
      }

      case 'hls-response': {
        const pending = pendingHls.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingHls.delete(msg.requestId)
        const data = msg.data ? Buffer.from(msg.data, 'base64') : null
        pending.resolve(data)
        break
      }

      case 'viewer-state': {
        const room = getRoomBySocket(socketId)
        if (!room || room.hostSocketId === socketId) return
        sendToSocket(room.hostSocketId, {
          type: 'viewer-state',
          userId: socketId,
          position: msg.position,
          isPaused: msg.isPaused,
          segmentsLoaded: msg.segmentsLoaded,
          segmentsTotal: msg.segmentsTotal
        })
        break
      }
    }
  })

  ws.on('close', () => {
    const result = leaveRoom(socketId)
    sockets.delete(socketId)
    if (result) {
      const { room, wasHost } = result
      if (wasHost) {
        broadcast(room.users.keys(), { type: 'host-left' })
        console.log(`[room] host disconnected, room ${room.id} destroyed`)
      } else {
        const allIds = [room.hostSocketId, ...room.users.keys()]
        broadcast(allIds, { type: 'user-left', userId: socketId })
      }
    }
  })
})

// ─── HLS proxy ────────────────────────────────────────────────────────────────

app.get('/room/:roomId/hls/:path(*)', async (req, res) => {
  const roomId = req.params['roomId']
  const path = (req.params as Record<string, string>)['path']
  const room = getRoom(roomId)
  if (!room) return res.status(404).send('Room not found')

  const hostWs = sockets.get(room.hostSocketId)
  if (!hostWs || hostWs.readyState !== WebSocket.OPEN) {
    return res.status(503).send('Host unavailable')
  }

  const requestId = randomUUID()

  const data = await new Promise<Buffer | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingHls.delete(requestId)
      resolve(null)
    }, 10_000)
    pendingHls.set(requestId, { resolve, timer })
    send(hostWs, { type: 'hls-request', requestId, path })
  })

  if (!data) return res.status(504).send('Host timeout')

  // Determine Content-Type
  if (path.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  } else if (path.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/mp2t')
  } else {
    res.setHeader('Content-Type', 'application/octet-stream')
  }
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.send(data)
})

// Rooms list (for debug / future UI)
app.get('/rooms', (_req, res) => {
  const list: unknown[] = []
  // rooms is private — expose via a helper if needed
  res.json(list)
})

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`beacon-relay running on http://localhost:${PORT}`)
})
