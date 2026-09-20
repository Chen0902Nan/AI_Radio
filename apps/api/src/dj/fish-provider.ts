import { FISH } from '../config/app-config'
import { FREE_MODEL, validateVoiceConfig, type SynthesizeInput, type SynthesizeResult } from './fish-contract'
import { parseFishResponse } from './fish-response'

function validateInput(input: SynthesizeInput): Extract<SynthesizeResult, { ok: false }> | null {
  const config = validateVoiceConfig(input)
  if (!config.ok) return { ok: false, code: config.code!, message: config.message! }
  const text = typeof input.text === 'string' ? input.text : ''
  if (!text.trim()) return { ok: false, code: 'error', message: '合成文案不能为空' }
  if (text.length > 1000) return { ok: false, code: 'error', message: '合成文案超过长度上限' }
  if (input.signal?.aborted) return { ok: false, code: 'cancelled', message: '合成请求已被取消' }
  return null
}
function fetchFailure(error: unknown, input: SynthesizeInput, timeoutMs: number): SynthesizeResult {
  if (input.signal?.aborted) return { ok: false, code: 'cancelled', message: '合成请求已被取消' }
  if (error instanceof Error && error.name === 'AbortError') return { ok: false, code: 'timeout', message: `Fish 合成超过 ${timeoutMs}ms 未返回，已取消` }
  return { ok: false, code: 'network', message: error instanceof Error ? error.message : String(error) }
}
export async function synthesizeProvider(input: SynthesizeInput): Promise<SynthesizeResult> {
  const invalid = validateInput(input)
  if (invalid) return invalid
  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : FISH.ttsTimeoutMs
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(onAbort, timeoutMs)
  const started = Date.now()
  try {
    const response = await (input.fetchImpl || fetch)(`${FISH.base}/v1/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}`, model: FREE_MODEL, 'content-type': 'application/json' },
      body: JSON.stringify({ text: input.text, reference_id: input.referenceId, format: 'mp3' }),
      signal: controller.signal,
    })
    // Keep cancellation active until the entire body has been parsed.
    return await parseFishResponse(response, FREE_MODEL, started, input.signal)
  } catch (error) { return fetchFailure(error, input, timeoutMs) }
  finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}
