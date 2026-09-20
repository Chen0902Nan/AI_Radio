import { FISH } from '../config/app-config'
import { FREE_MODEL, MAX_AUDIO_BYTES, type SynthesizeResult } from './fish-contract'

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


const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const FAILURES: Record<string, string> = {
  timeout: `合成超过 ${FISH.ttsTimeoutMs}ms 未返回`, auth: '密钥无效', quota: '额度受限',
  rate_limited: '限流', bad_audio: '返回内容不是有效 MP3',
}
export async function injectedSynthesis(): Promise<SynthesizeResult | null> {
  if (process.env.RADIO_TEST_HOOKS !== '1' || injectedMode === 'off') return null
  fishStats.injected += 1
  if (injectedDelayMs) await sleep(injectedDelayMs)
  const failure = FAILURES[injectedMode]
  if (failure) return { ok: false, code: injectedMode, message: `（测试注入）${failure}` }
  if (injectedMode === 'too_long') {
    const big = Buffer.alloc(MAX_AUDIO_BYTES + 1)
    return { ok: true, buffer: big, contentType: 'audio/mpeg', bytes: big.length, durationMs: 31000, model: FREE_MODEL }
  }
  if (injectedMode !== 'success' && injectedMode !== 'short') return null
  const mp3 = syntheticMp3(injectedMode === 'short' ? 12000 : 20000)
  return { ok: true, buffer: mp3.buffer, contentType: 'audio/mpeg', bytes: mp3.buffer.length, durationMs: mp3.durationMs, model: FREE_MODEL, meta: { injected: true } }
}
