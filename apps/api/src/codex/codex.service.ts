/** Public Codex selection adapter; state, subprocess and output validation have separate owners. */
import { Injectable } from '@nestjs/common'
import { CODEX } from '../config/app-config'
import { buildPrompt, validatePicks } from './codex-selection'
import { getCodexMode, recordCall, injectedPicks } from './codex-injection'
import { requestPicks } from './codex-provider'
import type { CodexCandidate, CodexResult } from './codex-types'

export type { CodexCandidate, CodexResult, ExecResult } from './codex-types'
export { execWithTimeout, classifyFailure, parseTokens } from './codex-process'
export { buildPrompt, validatePicks } from './codex-selection'
export { getCodexMode, setCodexMode, getStats, resetStats } from './codex-injection'

function selectResult(raw: unknown, candidates: CodexCandidate[], wanted: number, started: number, meta: Record<string, unknown>): CodexResult {
  const { valid, rejected, structurallyInvalid } = validatePicks(raw, candidates)
  if (structurallyInvalid || !valid.length) {
    return { ok: false, code: 'invalid_output', message: structurallyInvalid
      ? 'Codex 输出结构不符合 schema'
      : `Codex 输出的 ${rejected.length} 条全部不合法（id 不在候选集里 / 重复 / 缺理由）`, rejected, meta }
  }
  return { ok: true, picks: valid.slice(0, wanted), rejected, meta: { ...meta, durationMs: meta.durationMs ?? Date.now() - started } }
}

@Injectable()
export class CodexService {
  async pickTracks(opts: { candidates?: CodexCandidate[]; brief?: string; count?: number; timeoutMs?: number } = {}): Promise<CodexResult> {
    const { brief, count = 5, timeoutMs = CODEX.timeoutMs, candidates } = opts
    if (!Array.isArray(candidates) || !candidates.length) return { ok: false, code: 'no_candidates', message: '没有可用的候选歌曲', meta: {} }
    const wanted = Math.max(1, Math.min(Number(count) || 5, candidates.length))
    const started = Date.now()
    recordCall(started)
    const meta = { candidates: candidates.length, requested: wanted, timeoutMs, mode: getCodexMode() }
    const response = await injectedPicks(candidates, wanted, timeoutMs, started, meta)
      ?? await requestPicks(buildPrompt({ candidates, brief: brief || '随意，适合现在听', count: wanted }), timeoutMs, started, meta)
    if ('failure' in response) return response.failure
    return selectResult(response.raw, candidates, wanted, started, response.meta)
  }
}
