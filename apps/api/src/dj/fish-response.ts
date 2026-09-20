import { mp3Duration } from './mp3-duration'
import { MAX_AUDIO_BYTES, type SynthesizeResult } from './fish-contract'

type Failure = Extract<SynthesizeResult, { ok: false }>
async function failResponse(res: Response, code: string, message: string): Promise<Failure> {
  let detail = ''
  try { detail = (await res.text()).slice(0, 200) } catch (_) { /* Preserve the HTTP error if its body is interrupted. */ }
  return { ok: false, code, message: detail ? `${message}：${detail}` : message }
}
async function statusFailure(res: Response): Promise<Failure | null> {
  if (res.status === 401) return failResponse(res, 'auth', 'Fish 密钥无效或未授权（配置更新前不再重复请求）')
  if (res.status === 402) return failResponse(res, 'quota', 'Fish 账户额度/付费要求被拒（免费模型不应出现，需人工核查）')
  if (res.status === 429) return failResponse(res, 'rate_limited', 'Fish 限流')
  if (res.status < 400) return null
  const failure = await failResponse(res, 'error', `Fish 返回 HTTP ${res.status}`)
  if ((res.status === 400 || res.status === 404) && /reference not found|model not found/i.test(failure.message)) {
    return { ok: false, code: 'invalid_reference', message: '所选 Fish 音色不存在或已失效，请停止收听，更换音色试听成功后设为正式音色。' }
  }
  return failure
}
function validateBytes(buf: Buffer, declaredLength: number, contentType: string): Failure | null {
  if (declaredLength > 0 && buf.length !== declaredLength) return { ok: false, code: 'bad_audio', message: `音频响应不完整（应 ${declaredLength} 字节，实收 ${buf.length}）` }
  if (!/^audio\//i.test(contentType) && contentType) return { ok: false, code: 'bad_audio', message: `响应不是音频（content-type ${contentType}）` }
  if (!buf.length) return { ok: false, code: 'bad_audio', message: '音频响应为空' }
  if (buf.length > MAX_AUDIO_BYTES) return { ok: false, code: 'too_long', message: `音频超过 ${MAX_AUDIO_BYTES} 字节上限` }
  return null
}
async function readAudio(res: Response, externalSignal?: AbortSignal): Promise<Buffer | Failure> {
  try { return Buffer.from(await res.arrayBuffer()) }
  catch (error) {
    if (externalSignal?.aborted) return { ok: false, code: 'cancelled', message: '合成请求已被取消' }
    return { ok: false, code: 'bad_audio', message: '读取音频响应失败：' + (error instanceof Error ? error.message : String(error)) }
  }
}
export async function parseFishResponse(res: Response, model: string, started: number, externalSignal?: AbortSignal): Promise<SynthesizeResult> {
  const failure = await statusFailure(res)
  if (failure) return failure
  const contentType = res.headers.get('content-type') || ''
  const declaredLength = Number(res.headers.get('content-length') || 0)
  if (declaredLength > MAX_AUDIO_BYTES) return { ok: false, code: 'too_long', message: `音频超过 ${MAX_AUDIO_BYTES} 字节上限` }
  const buf = await readAudio(res, externalSignal)
  if (!Buffer.isBuffer(buf)) return buf
  const invalid = validateBytes(buf, declaredLength, contentType)
  if (invalid) return invalid
  const secs = mp3Duration(buf)
  if (secs === null) return { ok: false, code: 'bad_audio', message: '响应内容不是可解析的有效 MP3' }
  return { ok: true, buffer: buf, contentType: contentType || 'audio/mpeg', bytes: buf.length, durationMs: Math.round(secs * 1000), model, meta: { elapsedMs: Date.now() - started } }
}
