import type { PrepareRequest } from '@radio/contracts'

export type OrderResult = { ok: true } | { ok: false; code: 'session_ended' | 'stale_epoch' | 'payload_conflict'; message: string }
export interface SessionOrder {
  isOpen(sessionId: string): boolean
  accept(request: PrepareRequest): OrderResult
  isCurrent(request: PrepareRequest): boolean
}

/** Canonical validated payload, including script context: identity alone is insufficient. */
export function prepareFingerprint(request: PrepareRequest): string {
  return JSON.stringify([request.transitionId, request.fromItemId, request.targetItemId, request.targetTrackId,
    request.targetName || '', request.targetArtists || '', request.brief || ''])
}

export function compareOrder(epoch: number, seq: number, latestEpoch: number, latestSeq: number): number {
  return epoch === latestEpoch ? seq - latestSeq : epoch - latestEpoch
}

/** Request ordering outlives individual job retention; closed sessions never reopen locally. */
export function createRequestGate(sessions: SessionOrder | undefined) {
  const latest = new Map<string, PrepareRequest>()
  const closed = new Set<string>()
  function accept(request: PrepareRequest): OrderResult {
    if (closed.has(request.sessionId) || !sessions?.isOpen(request.sessionId)) {
      return { ok: false, code: 'session_ended', message: '没有进行中的匹配收听会话' }
    }
    const previous = latest.get(request.sessionId)
    if (previous) {
      const order = compareOrder(request.epoch, request.transitionSeq, previous.epoch, previous.transitionSeq)
      if (order < 0) return { ok: false, code: 'stale_epoch', message: '准备请求早于最新机会' }
      if (order === 0 && prepareFingerprint(previous) !== prepareFingerprint(request)) return { ok: false, code: 'payload_conflict', message: '相同顺序携带不同内容' }
    }
    const accepted = sessions.accept(request)
    if (accepted.ok) latest.set(request.sessionId, request)
    return accepted
  }
  return {
    accept,
    isCurrent(request: PrepareRequest): boolean {
      const current = latest.get(request.sessionId)
      return !closed.has(request.sessionId) && current?.epoch === request.epoch && current.transitionSeq === request.transitionSeq
        && prepareFingerprint(current) === prepareFingerprint(request)
        && Boolean(sessions?.isOpen(request.sessionId) && sessions.isCurrent(request))
    },
    close(sessionId: string) { closed.add(sessionId) },
  }
}
