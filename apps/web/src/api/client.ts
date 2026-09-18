/**
 * HTTP 客户端（迁移自 public/app.js 的 fetch 调用）：返回统一的 { ok, status, ...data }。
 * 错误体形状遵循 docs/migration/route-contract.md。
 */
import type { ResolveResult } from '../playback/playback-controller'

async function call(pathname: string, init?: RequestInit): Promise<Record<string, unknown> & { ok: boolean; status: number }> {
  const res = await fetch(pathname, init)
  let data: Record<string, unknown> = {}
  try {
    data = await res.json()
  } catch (_) {}
  return { ...data, ok: res.ok, status: res.status }
}

const post = (pathname: string, body?: unknown) =>
  call(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

export interface AccountInfo {
  userId: number
  nickname: string
  vipType: number
  savedAt?: string
}

export interface LibraryTrack {
  id: number
  name: string
  artists: string
  album: string
  durationMs: number
  fee?: number
}

export const api = {
  health: () => call('/api/health'),
  library: () => call('/api/library'),
  playlist: (id: string | number) => call('/api/playlist/' + id),
  resolve: (id: number, force = false): Promise<ResolveResult> =>
    call(`/api/resolve/${id}${force ? '?force=1' : ''}`) as unknown as Promise<ResolveResult>,
  session: () => call('/api/session'),
  sessionStart: () => post('/api/session/start'),
  sessionStop: () => post('/api/session/stop'),
  adjustment: (key: string, value: unknown) => post('/api/session/adjustment', { key, value }),
  feedback: () => call('/api/feedback'),
  addFeedback: (body: { trackId: number; trackName: string; artists: string; sentiment: 'like' | 'dislike' }) => post('/api/feedback', body),
  revokeFeedback: (trackId: number) => call('/api/feedback/' + trackId, { method: 'DELETE' }),
  settings: () => call('/api/settings'),
  saveSetting: (key: string, value: unknown) => post('/api/settings', { key, value }),
  playStart: (body: { trackId: number; trackName: string; artists: string; sessionId?: string | null; playInstanceId?: string; selectionId?: string }) => post('/api/plays/start', body),
  playEnd: (playId: number, outcome: string) => post('/api/plays/end', { playId, outcome }),
  plan: (body: { brief: string; count: number; epoch?: number; sessionId?: string | null; excludeIds?: number[] }) => post('/api/plan', body),
  refill: (body: { sessionId: string | null; epoch: number; excludeIds: number[]; count: number; brief: string }) => post('/api/queue/refill', body),
  djPrepare: (body: Record<string, unknown>) => post('/api/dj/prepare', body),
  djJob: (id: string) => call('/api/dj/jobs/' + id),
  djCancel: (id: string, reason: string) => post(`/api/dj/jobs/${id}/cancel`, { reason }),
  djPreview: (referenceId: string) => post('/api/dj/preview', { referenceId }),
}
