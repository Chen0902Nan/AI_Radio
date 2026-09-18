/**
 * Fish Audio 免费语音合成适配（迁移自 server/fish.js）。
 *
 * 免费约束（零新增语音费用）：
 *  - `model` 是请求头，不是 body 字段；显式固定 `s2.1-pro-free`。配置未知值直接拒绝，
 *    绝不静默回落或省略请求头。
 *  - 未配置密钥/有效音色时返回 not_configured，不发起任何供应商请求。
 *
 * 成品有效性：HTTP 200 不等于成功。必须 content-type 是音频、长度完整且不超上限、
 * 且能解析出时长，否则按 bad_audio / too_long 拒绝。请求有界可取消；所有失败都不抛出。
 */
import { Injectable } from '@nestjs/common'
import { mp3Duration } from './mp3-duration'
import { FISH } from '../config/app-config'

export const FREE_MODEL = 's2.1-pro-free'
/** 单个成品大小上限：30 秒 MP3（≤320kbps）约 1.2 MiB，上限留裕量防失控响应。 */
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024

/* ---------- 测试注入（仅 RADIO_TEST_HOOKS=1） ---------- */

let injectedMode = 'off'
let injectedDelayMs = 0
const fishStats = { injected: 0, lastMode: 'off' }

export function setFishMode(mode: string, { delayMs }: { delayMs?: number } = {}): string {
  injectedMode = mode || 'off'
  if (delayMs !== undefined) injectedDelayMs = Math.max(0, Number(delayMs) || 0)
  fishStats.lastMode = injectedMode
  return injectedMode
}

/** 构造一段可解析的 MPEG1 Layer3 CBR 静音 MP3（128kbps/44.1kHz）。 */
export function syntheticMp3(durationMs: number): { buffer: Buffer; durationMs: number } {
  const frameBytes = 417
  const frames = Math.max(1, Math.round((durationMs / 1000) * (44100 / 1152)))
  const buf = Buffer.alloc(frames * frameBytes)
  for (let i = 0; i < frames; i++) {
    buf[i * frameBytes] = 0xff
    buf[i * frameBytes + 1] = 0xfb
    buf[i * frameBytes + 2] = 0x90
    buf[i * frameBytes + 3] = 0x00
  }
  return { buffer: buf, durationMs: Math.round((frames * 1152 * 1000) / 44100) }
}

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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

@Injectable()
export class FishService {
  /** 时长有效性（模块级 evaluateAudioDuration 的实例转发，保持旧导出面）。 */
  evaluateAudioDuration(durationMs: number, opts?: { maxMs?: number; minMs?: number }): { withinProgramLimit: boolean; code: string | null; deviation: string | null } {
    return evaluateAudioDurationImpl(durationMs, opts)
  }

  /** 语音配置校验（模块级 validateVoiceConfig 的实例转发）。 */
  validateVoiceConfig(input?: { apiKey?: string | null; referenceId?: string | null; model?: string | null }): { ok: boolean; code?: string; message?: string; model?: string } {
    return validateVoiceConfig(input)
  }

  /** 合成一段语音。所有失败都不抛出。 */
  /** 合成一段语音。所有失败都不抛出。（模块级 synthesizeImpl 的实例转发，保持旧导出面） */
  async synthesize(input: SynthesizeInput = {}): Promise<SynthesizeResult> {
    return synthesizeImpl(input)
  }

}

export { evaluateAudioDurationImpl as evaluateAudioDuration }

async function failRes(res: Response, code: string, message: string): Promise<{ ok: false; code: string; message: string }> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 200)
  } catch (_) {}
  return { ok: false, code, message: detail ? `${message}：${detail}` : message }
}

/** 模块级合成实现（与旧 server/fish.js 的 synthesize 等价，测试可直接调用）。 */
export async function synthesize(input: SynthesizeInput = {}): Promise<SynthesizeResult> {
  return synthesizeImpl(input)
}

async function synthesizeImpl(input: SynthesizeInput = {}): Promise<SynthesizeResult> {
    if (process.env.RADIO_TEST_HOOKS === '1' && injectedMode !== 'off') {
      fishStats.injected += 1
      if (injectedDelayMs) await sleep(injectedDelayMs)
      const fail = (code: string, message: string) => ({ ok: false as const, code, message: `（测试注入）${message}` })
      if (injectedMode === 'timeout') return fail('timeout', `合成超过 ${FISH.ttsTimeoutMs}ms 未返回`)
      if (injectedMode === 'auth') return fail('auth', '密钥无效')
      if (injectedMode === 'quota') return fail('quota', '额度受限')
      if (injectedMode === 'rate_limited') return fail('rate_limited', '限流')
      if (injectedMode === 'bad_audio') return fail('bad_audio', '返回内容不是有效 MP3')
      if (injectedMode === 'too_long') {
        const big = Buffer.alloc(MAX_AUDIO_BYTES + 1)
        return { ok: true, buffer: big, contentType: 'audio/mpeg', bytes: big.length, durationMs: 31000, model: FREE_MODEL }
      }
      if (injectedMode === 'success' || injectedMode === 'short') {
        const mp3 = syntheticMp3(injectedMode === 'short' ? 12000 : 20000)
        return { ok: true, buffer: mp3.buffer, contentType: 'audio/mpeg', bytes: mp3.buffer.length, durationMs: mp3.durationMs, model: FREE_MODEL, meta: { injected: true } }
      }
    }

    const cfg = validateVoiceConfig(input)
    if (!cfg.ok) return { ok: false, code: cfg.code!, message: cfg.message! }

    const text = typeof input.text === 'string' ? input.text : ''
    if (!text.trim()) return { ok: false, code: 'error', message: '合成文案不能为空' }
    if (text.length > 1000) return { ok: false, code: 'error', message: '合成文案超过长度上限' }

    const fetchImpl = input.fetchImpl || fetch
    const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : FISH.ttsTimeoutMs
    const controller = new AbortController()
    const onExternalAbort = () => controller.abort()
    if (input.signal) {
      if (input.signal.aborted) return { ok: false, code: 'cancelled', message: '合成请求已被取消' }
      input.signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res: Response
    const started = Date.now()
    try {
      res = await fetchImpl(`${FISH.base}/v1/tts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          model: cfg.model!,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text,
          reference_id: input.referenceId,
          format: 'mp3',
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if (input.signal && input.signal.aborted) return { ok: false, code: 'cancelled', message: '合成请求已被取消' }
      if (err && (err as Error).name === 'AbortError') return { ok: false, code: 'timeout', message: `Fish 合成超过 ${timeoutMs}ms 未返回，已取消` }
      return { ok: false, code: 'network', message: String((err as Error).message || err) }
    } finally {
      if (input.signal) input.signal.removeEventListener('abort', onExternalAbort)
    }

    try {
      // 必须 await：错误正文读取同样受超时约束，直接 return 会先清掉定时器。
      if (res.status === 401) return await failRes(res, 'auth', 'Fish 密钥无效或未授权（配置更新前不再重复请求）')
      if (res.status === 402) return await failRes(res, 'quota', 'Fish 账户额度/付费要求被拒（免费模型不应出现，需人工核查）')
      if (res.status === 429) return await failRes(res, 'rate_limited', 'Fish 限流')
      if (res.status === 400 || res.status === 404) {
        const failure = await failRes(res, 'error', `Fish 返回 HTTP ${res.status}`)
        if (/reference not found|model not found/i.test(failure.message)) {
          return { ok: false, code: 'invalid_reference', message: '所选 Fish 音色不存在或已失效，请停止收听，更换音色试听成功后设为正式音色。' }
        }
        return failure
      }
      if (res.status >= 400) return await failRes(res, 'error', `Fish 返回 HTTP ${res.status}`)

      const contentType = (res.headers && res.headers.get('content-type')) || ''
      const declaredLength = Number((res.headers && res.headers.get('content-length')) || 0)
      if (declaredLength > MAX_AUDIO_BYTES) {
        return { ok: false, code: 'too_long', message: `音频超过 ${MAX_AUDIO_BYTES} 字节上限` }
      }

      let buf: Buffer
      try {
        const ab = await res.arrayBuffer()
        buf = Buffer.from(ab)
      } catch (err) {
        return { ok: false, code: 'bad_audio', message: '读取音频响应失败：' + String((err as Error).message || err) }
      }
      if (declaredLength > 0 && buf.length !== declaredLength) {
        return { ok: false, code: 'bad_audio', message: `音频响应不完整（应 ${declaredLength} 字节，实收 ${buf.length}）` }
      }
      if (!/^audio\//i.test(contentType) && contentType) {
        return { ok: false, code: 'bad_audio', message: `响应不是音频（content-type ${contentType}）` }
      }
      if (buf.length === 0) return { ok: false, code: 'bad_audio', message: '音频响应为空' }
      if (buf.length > MAX_AUDIO_BYTES) {
        return { ok: false, code: 'too_long', message: `音频超过 ${MAX_AUDIO_BYTES} 字节上限` }
      }
      const secs = mp3Duration(buf)
      if (secs === null) {
        return { ok: false, code: 'bad_audio', message: '响应内容不是可解析的有效 MP3' }
      }
      return {
        ok: true,
        buffer: buf,
        contentType: contentType || 'audio/mpeg',
        bytes: buf.length,
        durationMs: Math.round(secs * 1000),
        model: cfg.model!,
        meta: { elapsedMs: Date.now() - started },
      }
    } finally {
      clearTimeout(timer)
    }

}
