import { PROGRAM_TYPES, type ProgramType, MAX_AUDIO_MS, AUDIO_URL_PREFIX, type SegueAudio, type QueueItem, type ValidationError, type ValidationResult } from './models.js'
import { isNonEmptyString, toInt, err, result, failure } from './validation-utils.js'
import { makeTrackItem, makeSegueItem } from './identity.js'
import { validateScript } from './script-validation.js'

export function validateSegueAudio(audio: unknown): ValidationResult<SegueAudio> {
  if (!audio || typeof audio !== 'object') return failure([err('audio', 'missing_audio', '缺少音频')])
  const a = audio as Record<string, unknown>
  const errors: ValidationError[] = []
  if (!isNonEmptyString(a.assetId)) errors.push(err('assetId', 'invalid_asset_id', '缺少 assetId'))
  if (typeof a.url !== 'string' || !a.url.startsWith(AUDIO_URL_PREFIX) || a.url.includes('://')) errors.push(err('url', 'invalid_audio_url', '音频必须使用同源地址'))
  if (typeof a.durationMs !== 'number' || !Number.isFinite(a.durationMs) || a.durationMs <= 0) errors.push(err('durationMs', 'invalid_audio_duration', '时长必须是正数'))
  else if (a.durationMs > MAX_AUDIO_MS) errors.push(err('durationMs', 'audio_too_long', '音频超过上限'))
  if (typeof a.bytes !== 'number' || !Number.isSafeInteger(a.bytes) || a.bytes <= 0) errors.push(err('bytes', 'invalid_audio_bytes', '音频字节数必须是正整数'))
  if (errors.length) return failure(errors)
  return result(true, { assetId: String(a.assetId), url: String(a.url), durationMs: Number(a.durationMs), bytes: Number(a.bytes) })
}

export function validateQueueItem(item: unknown): ValidationResult<QueueItem> {
  const errors: ValidationError[] = []
  if (!item || typeof item !== 'object') return failure([err('', 'not_object', '节目条目必须是对象')])
  const v = item as Record<string, unknown>
  if (!isNonEmptyString(v.itemId)) errors.push(err('itemId', 'missing_item_id', '条目缺少 itemId'))
  if (v.type === undefined && v.id !== undefined && toInt(v.id) !== null) {
    errors.push(err('type', 'legacy_track_shape', '旧歌曲对象（只有数字 id）需先经 makeTrackItem 适配为节目条目'))
  } else if (!PROGRAM_TYPES.includes(v.type as ProgramType)) {
    errors.push(err('type', 'invalid_program_type', `type 必须是 ${PROGRAM_TYPES.join(' 或 ')}`))
  }
  if (v.type === 'track') {
    if (toInt(v.trackId) === null) errors.push(err('trackId', 'invalid_track_id', '歌曲条目缺少数字 trackId'))
  }
  if (v.type === 'segue') {
    if (!isNonEmptyString(v.segueId)) errors.push(err('segueId', 'missing_segue_id', '播报条目缺少 segueId'))
    if (Object.prototype.hasOwnProperty.call(v, 'id') && Number.isFinite(Number(v.id))) {
      errors.push(err('id', 'segue_masquerades_track_id', '播报条目不能携带歌曲数字 id'))
    }
  }
  if (errors.length) return failure(errors)
  if (v.type === 'track') return result(true, makeTrackItem(v, { itemId: String(v.itemId), addedAt: Number(v.addedAt) }))
  if (v.script != null) {
    const script = validateScript(v.script)
    if (!script.ok) return failure(script.errors)
  }
  if (v.audio != null) {
    const audio = validateSegueAudio(v.audio)
    if (!audio.ok) return failure(audio.errors)
  }
  return result(true, makeSegueItem({
    itemId: String(v.itemId), segueId: String(v.segueId),
    transitionId: String(v.transitionId || ''), fromItemId: String(v.fromItemId || ''),
    targetItemId: String(v.targetItemId || ''), targetTrackId: toInt(v.targetTrackId),
    script: v.script == null ? null : validateScript(v.script).value!,
    audio: v.audio == null ? null : validateSegueAudio(v.audio).value!, createdAt: Number(v.createdAt),
  }))
}
