import { validateScript } from './script-validation.js'
import { validateSegueAudio } from './queue-validation.js'
import type {
  AccountInfo, LibraryTrack, PlaylistInfo, LibraryPayload, PlaylistPayload, ResolvePayload,
  SessionInfo, SessionPayload, SettingsPayload, DjVoiceInfo, FeedbackInfo, FeedbackPayload,
  PickInfo, PicksPayload, DjAudioInfo, DjJobInfo, PlayStartPayload,
} from './http-types.js'
import { objectValue as obj, stringValue as str, numberValue as num, idValue as id, booleanValue as bool, arrayValue as arr, optional, mediaUrl, integerValue as integer, identityValue as identity } from './http-readers.js'
export * from './http-types.js'

function account(value: unknown): AccountInfo | null {
  if (value === null) return null
  const v = obj(value)
  return { userId: id(v.userId), nickname: str(v.nickname), vipType: optional(v.vipType, num), savedAt: optional(v.savedAt, str) }
}
function track(value: unknown): LibraryTrack {
  const v = obj(value)
  return { id: id(v.id), name: str(v.name), artists: str(v.artists), album: str(v.album), durationMs: num(v.durationMs), fee: optional(v.fee, num) }
}
function playlist(value: unknown): PlaylistInfo {
  const v = obj(value)
  return { id: id(v.id), name: str(v.name), trackCount: num(v.trackCount) }
}
export function parseLibrary(value: unknown): LibraryPayload {
  const v = obj(value), liked = obj(v.liked), lists = obj(v.playlists)
  return { account: account(v.account), liked: { count: num(liked.count), tracks: arr(liked.tracks, track) }, playlists: { created: arr(lists.created, playlist), collected: arr(lists.collected, playlist), total: num(lists.total) } }
}
export function parsePlaylist(value: unknown): PlaylistPayload {
  const v = obj(value)
  return { tracks: arr(v.tracks, track), returned: num(v.returned), trackCount: num(v.trackCount), via: str(v.via) }
}
export function parseResolve(value: unknown): ResolvePayload {
  const v = obj(value), playable = bool(v.playable)
  return { playable, audioUrl: playable ? mediaUrl(v.audioUrl) : null }
}
function session(value: unknown): SessionInfo {
  const v = obj(value)
  return { id: identity(v.id), adjustments: v.adjustments === undefined ? {} : obj(v.adjustments), highest_epoch: v.highest_epoch === undefined ? 0 : integer(v.highest_epoch), transition_seq: v.transition_seq === undefined ? -1 : integer(v.transition_seq, -1) }
}
export function parseSession(value: unknown): SessionPayload {
  const v = obj(value)
  return { session: v.session === null ? null : session(v.session) }
}
function voice(value: unknown): DjVoiceInfo {
  const v = obj(value)
  return { ready: bool(v.ready), voiceReferenceId: v.voiceReferenceId == null ? null : str(v.voiceReferenceId), code: v.code == null ? null : str(v.code), message: v.message === undefined ? '' : str(v.message) }
}
export function parseSettings(value: unknown): SettingsPayload {
  const v = obj(value), settings = obj(v.settings)
  return { settings: Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, str(value)])), djVoice: optional(v.djVoice, voice) }
}
function feedback(value: unknown): FeedbackInfo {
  const v = obj(value)
  if (v.sentiment !== 'like' && v.sentiment !== 'dislike') throw new Error('无效反馈')
  return { track_id: id(v.track_id), track_name: v.track_name === null ? null : optional(v.track_name, str), sentiment: v.sentiment }
}
export function parseFeedback(value: unknown): FeedbackPayload {
  return { active: arr(obj(value).active, feedback) }
}
function selectionSource(value: unknown): 'library' | 'discovery' {
  if (value !== 'library' && value !== 'discovery') throw new Error('无效选歌来源')
  return value
}
function pick(value: unknown): PickInfo {
  const v = obj(value)
  return {
    id: id(v.id), name: str(v.name), artists: str(v.artists), reason: v.reason === undefined ? '' : str(v.reason),
    album: optional(v.album, str), durationMs: optional(v.durationMs, num), selectionId: optional(v.selectionId, str),
    selectionSource: optional(v.selectionSource, selectionSource), fromCodex: optional(v.fromCodex, bool), degraded: optional(v.degraded, bool),
  }
}
export function parsePicks(value: unknown): PicksPayload {
  const v = obj(value)
  const meta = v.meta === undefined ? undefined : obj(v.meta)
  return { picks: arr(v.picks, pick), degraded: optional(v.degraded, bool), source: optional(v.source, str), meta: meta ? { durationMs: optional(meta.durationMs, num) } : undefined }
}
function audio(value: unknown): DjAudioInfo {
  const parsed = validateSegueAudio(value)
  if (!parsed.ok || !parsed.value) throw new Error('无效 DJ 音频')
  return parsed.value
}
export function parsePreview(value: unknown): { audio: DjAudioInfo } {
  return { audio: audio(obj(value).audio) }
}
function jobState(value: unknown): DjJobInfo['state'] {
  switch (value) {
    case 'preparing':
    case 'ready':
    case 'unavailable':
    case 'stale':
    case 'cancelled': return value
    default: throw new Error('无效任务状态')
  }
}
export function parseJob(value: unknown): { job: DjJobInfo } {
  const v = obj(obj(value).job)
  const state = jobState(v.state)
  const job: DjJobInfo = { segueId: identity(v.segueId), state, code: v.code == null ? undefined : str(v.code), message: v.message == null ? undefined : str(v.message) }
  if (state === 'ready') {
    const script = validateScript(v.script)
    if (!script.ok || !script.value) throw new Error('无效 DJ 文案')
    job.script = script.value
    job.audio = audio(v.audio)
  }
  return { job }
}
export function parsePlayStart(value: unknown): PlayStartPayload {
  const v = obj(value)
  return { playId: id(v.playId), session: session(v.session) }
}
export function parseAcknowledgement(value: unknown): object {
  if (obj(value).ok !== true) throw new Error('缺少成功确认')
  return {}
}
export function parseHealth(value: unknown): { loggedIn: boolean; account: AccountInfo | null; testHooks: boolean } {
  const v = obj(value)
  return { loggedIn: bool(v.loggedIn), account: account(v.account), testHooks: bool(v.testHooks) }
}
export function parseAdjustment(value: unknown): { adjustments: Record<string, unknown> } {
  return { adjustments: obj(obj(value).adjustments) }
}
