import type { PrepareRequest, SegueScript, SegueAudio } from './models.js'

/** HTTP 边界的已解析结构；供应商原始结构不得跨过此边界。 */
export interface ApiError { ok: false; status: number; code?: string; message?: string }
export type ApiResult<T> = ({ ok: true; status: number; code?: string; message?: string } & T) | ApiError
export interface AccountInfo { userId: number; nickname: string; vipType?: number; savedAt?: string }
export interface LibraryTrack { id: number; name: string; artists: string; album: string; durationMs: number; fee?: number }
export interface PlaylistInfo { id: number; name: string; trackCount: number }
export interface LibraryPayload {
  account: AccountInfo | null
  liked: { count: number; tracks: LibraryTrack[] }
  playlists: { created: PlaylistInfo[]; collected: PlaylistInfo[]; total: number }
}
export interface PlaylistPayload { tracks: LibraryTrack[]; returned: number; trackCount: number; via: string }
export interface ResolvePayload { playable: boolean; audioUrl: string | null }
export interface SessionInfo { id: string; adjustments: Record<string, unknown>; highest_epoch: number; transition_seq: number }
export interface SessionPayload { session: SessionInfo | null }
export interface DjVoiceInfo { ready: boolean; voiceReferenceId: string | null; code: string | null; message: string }
export interface SettingsPayload { settings: Record<string, string>; djVoice?: DjVoiceInfo }
export interface FeedbackInfo { track_id: number; track_name?: string | null; sentiment: 'like' | 'dislike' }
export interface FeedbackPayload { active: FeedbackInfo[] }
export type PickInfo = {
  id: number; name: string; artists: string; album?: string; durationMs?: number; reason: string
  selectionId?: string; selectionSource?: 'library' | 'discovery'; fromCodex?: boolean; degraded?: boolean
}
export type PicksPayload = { picks: PickInfo[]; degraded?: boolean; source?: string; meta?: { durationMs?: number } }
export type DjAudioInfo = SegueAudio
export interface DjJobInfo {
  segueId: string
  state: 'preparing' | 'ready' | 'unavailable' | 'stale' | 'cancelled'
  script?: SegueScript | null
  audio?: DjAudioInfo | null
  code?: string
  message?: string
}
export interface PlayStartPayload { playId: number; session: SessionInfo }
export interface PlayStartRequest {
  trackId: number; trackName: string; artists: string; sessionId?: string | null; playInstanceId?: string; selectionId?: string
}
export interface PlanRequest { brief: string; count: number; epoch?: number; sessionId?: string | null; excludeIds?: number[] }
export interface RefillRequest { sessionId: string | null; epoch: number; excludeIds: number[]; count: number; brief: string }
export interface FeedbackRequest { trackId: number; trackName: string; artists: string; sentiment: 'like' | 'dislike' }
export type DjPrepareRequest = PrepareRequest
