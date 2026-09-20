import { type ValidationError, type ValidationDeviation, type ValidationResult } from './models.js'

let __seq = 0
export function makeId(prefix: string): string {
  __seq = (__seq + 1) % 0xffff
  return `${prefix}_${Date.now().toString(36)}${__seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 数字或数字字符串 → 非负整数；否则 null。用于 trackId/epoch 等平台数字身份。 */
export function toInt(v: unknown): number | null {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null
  const n = Number(v)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export const err = (path: string, code: string, message: string): ValidationError => ({ path, code, message })

export function result<T>(ok: boolean, value: T | undefined, errors: ValidationError[] = [], deviations: ValidationDeviation[] = []): ValidationResult<T> {
  return { ok, value, errors, deviations }
}

/** 拒绝分支：value 恒为 undefined，由调用点推断目标类型。 */
export function failure<T>(errors: ValidationError[], deviations: ValidationDeviation[] = []): ValidationResult<T> {
  return { ok: false, value: undefined, errors, deviations }
}

/** 估算中文播报时长（秒）：CJK/全角字符记 1，其他可见字符记 0.5，忽略空白。 */
export function estimateSpeechSeconds(text: unknown, charsPerSecond?: number): number {
  const s = String(text || '')
  let units = 0
  for (const ch of s) {
    if (/\s/.test(ch)) continue
    units += /[　-鿿豈-﫿＀-￯]/.test(ch) ? 1 : 0.5
  }
  const cps = Number(charsPerSecond) > 0 ? Number(charsPerSecond) : 4
  return units / cps
}
