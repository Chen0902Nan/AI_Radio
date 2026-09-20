import type { PrepareOptions } from './orchestrator.service'

/** 仅适配既有 HTTP 默认值；会话有效性由业务入口判断。 */
export function preparationInput(body: Record<string, unknown>, defaultCount: number): Partial<PrepareOptions> {
  return {
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    epoch: Number(body.epoch) || 0,
    excludeIds: Array.isArray(body.excludeIds) ? body.excludeIds : [],
    count: Number(body.count) || defaultCount,
    brief: typeof body.brief === 'string' ? body.brief.slice(0, 200) : '',
    timeoutMs: Number(body.timeoutMs) || undefined,
    skipCodex: Boolean(body.skipCodex),
  }
}

export function preparationStatus(code: string): number {
  if (code === 'session_ended' || code === 'candidates_exhausted') return 409
  if (code === 'music_unavailable' || code === 'library_unavailable') return 503
  return 502
}
