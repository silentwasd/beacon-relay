// ─── Shared types ────────────────────────────────────────────────────────────

export interface UserProfile {
  nickname: string
  /** base64-encoded JPEG 200x200, may be absent */
  avatar?: string
}

export interface VideoInfo {
  name: string
  folderName: string
  sourceHash: string
  segmentCount: number
  duration: number
}

export interface PlayerState {
  position: number
  isPaused: boolean
  updatedAt: number
}

// ─── Client → Server messages ─────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'create-room'; profile: UserProfile; videoInfo: VideoInfo }
  | { type: 'join-room'; roomId: string; profile: UserProfile }
  | { type: 'leave-room' }
  | { type: 'sync'; action: 'play' | 'pause' | 'seek'; position: number; ts: number }
  | { type: 'hls-response'; requestId: string; data: string | null } // base64 segment data
  | { type: 'viewer-state'; position: number; isPaused: boolean; segmentsLoaded: number; segmentsTotal: number }

// ─── Server → Client messages ─────────────────────────────────────────────────

export type ServerMessage =
  | { type: 'room-created'; roomId: string }
  | { type: 'room-joined'; roomId: string; videoInfo: VideoInfo; hostProfile: UserProfile; users: Record<string, UserProfile>; playerState: PlayerState }
  | { type: 'error'; message: string }
  | { type: 'user-joined'; userId: string; profile: UserProfile }
  | { type: 'user-left'; userId: string }
  | { type: 'host-left' }
  | { type: 'sync'; action: 'play' | 'pause' | 'seek'; position: number; ts: number }
  | { type: 'hls-request'; requestId: string; path: string }
  | { type: 'viewer-state'; userId: string; position: number; isPaused: boolean; segmentsLoaded: number; segmentsTotal: number }
