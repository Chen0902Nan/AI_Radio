/** 所有共享响应在此解析；组件只消费通过校验的契约。 */
import {
  parseLibrary, parsePlaylist, parseResolve, parseSession, parseSettings, parseFeedback,
  parsePicks, parseJob, parsePreview, parsePlayStart, parseAcknowledgement, parseHealth, parseAdjustment,
  type ApiResult, type PlayStartRequest, type PlanRequest, type RefillRequest, type FeedbackRequest, type DjPrepareRequest,
} from '@radio/contracts'
export type { AccountInfo, LibraryTrack } from '@radio/contracts'

function envelope(value: unknown): { ok?: unknown; code?: string; message?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const body = value as Record<string, unknown>
  return {
    ok: body.ok,
    code: typeof body.code === 'string' ? body.code : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
  }
}

async function call<T>(pathname: string, parse: (value: unknown) => T, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(pathname, init)
  let data: unknown
  try {
    data = await res.json()
  } catch {
    return { ok: false, status: res.status, code: 'invalid_response', message: '服务返回了无效 JSON' }
  }
  const body = envelope(data)
  const { code, message } = body
  if (!res.ok || body.ok === false) return { ok: false, status: res.status, code, message }
  try {
    if (body.ok !== undefined && typeof body.ok !== 'boolean') throw new Error('ok 应为布尔值')
    return { ...parse(data), ok: true, status: res.status, code, message }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, status: res.status, code: 'invalid_response', message: '服务响应格式错误：' + detail }
  }
}

function post<T>(pathname: string, parse: (value: unknown) => T, body?: unknown): Promise<ApiResult<T>> {
  return call(pathname, parse, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
}

export const api = {
  health: () => call('/api/health', parseHealth),
  library: () => call('/api/library', parseLibrary),
  playlist: (id: string | number) => call('/api/playlist/' + id, parsePlaylist),
  resolve: (id: number, force = false) => call(`/api/resolve/${id}${force ? '?force=1' : ''}`, parseResolve),
  session: () => call('/api/session', parseSession),
  sessionStart: () => post('/api/session/start', parseSession),
  sessionStop: () => post('/api/session/stop', parseAcknowledgement),
  adjustment: (key: string, value: unknown) => post('/api/session/adjustment', parseAdjustment, { key, value }),
  feedback: () => call('/api/feedback', parseFeedback),
  addFeedback: (body: FeedbackRequest) => post('/api/feedback', parseAcknowledgement, body),
  revokeFeedback: (trackId: number) => call('/api/feedback/' + trackId, parseAcknowledgement, { method: 'DELETE' }),
  settings: () => call('/api/settings', parseSettings),
  saveSetting: (key: string, value: unknown) => post('/api/settings', parseSettings, { key, value }),
  playStart: (body: PlayStartRequest) => post('/api/plays/start', parsePlayStart, body),
  playEnd: (playId: number, outcome: string) => post('/api/plays/end', parseAcknowledgement, { playId, outcome }),
  plan: (body: PlanRequest) => post('/api/plan', parsePicks, body),
  refill: (body: RefillRequest) => post('/api/queue/refill', parsePicks, body),
  djPrepare: (body: DjPrepareRequest) => post('/api/dj/prepare', parseJob, body),
  djJob: (id: string) => call('/api/dj/jobs/' + id, parseJob),
  djCancel: (id: string, reason: string) => post(`/api/dj/jobs/${id}/cancel`, parseAcknowledgement, { reason }),
  djPreview: (referenceId: string) => post('/api/dj/preview', parsePreview, { referenceId }),
}
