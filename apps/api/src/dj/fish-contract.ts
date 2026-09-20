export const FREE_MODEL = 's2.1-pro-free'
/** 单个成品大小上限：30 秒 MP3（≤320kbps）约 1.2 MiB，上限留裕量防失控响应。 */
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024


/**
 * 语音配置校验。model 缺省视为免费模型（实现固定）；显式配置成其他值一律拒绝。
 */
export function validateVoiceConfig({ apiKey, referenceId, model }: { apiKey?: string | null; referenceId?: string | null; model?: string | null } = {}): { ok: boolean; code?: string; message?: string; model?: string } {
  if (!apiKey || typeof apiKey !== 'string') {
    return { ok: false, code: 'not_configured', message: '未配置 Fish 密钥（服务端环境变量）' }
  }
  if (!referenceId || typeof referenceId !== 'string') {
    return { ok: false, code: 'not_configured', message: '未配置有效音色 reference_id' }
  }
  if (model !== undefined && model !== null && model !== '' && model !== FREE_MODEL) {
    return { ok: false, code: 'unknown_model', message: ` Fish 模型必须是 ${FREE_MODEL}，拒绝回落付费模型` }
  }
  return { ok: true, model: FREE_MODEL }
}


export interface SynthesizeInput {
  text?: string
  apiKey?: string
  referenceId?: string
  model?: string
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export type SynthesizeResult =
  | { ok: true; buffer: Buffer; contentType: string; bytes: number; durationMs: number; model: string; meta?: Record<string, unknown> }
  | { ok: false; code: string; message: string }

/** 时长有效性：超过 30 秒不能进正式节目；短于 15 秒的有效基础介绍记录偏差。 */
export function evaluateAudioDurationImpl(durationMs: number, { maxMs = 30000, minMs = 15000 } = {}): { withinProgramLimit: boolean; code: string | null; deviation: string | null } {
  const ms = Number(durationMs)
  if (!Number.isFinite(ms) || ms <= 0) return { withinProgramLimit: false, code: 'audio_too_long', deviation: null }
  if (ms > maxMs) return { withinProgramLimit: false, code: 'audio_too_long', deviation: null }
  return { withinProgramLimit: true, code: null, deviation: ms < minMs ? 'below_target_seconds' : null }
}
