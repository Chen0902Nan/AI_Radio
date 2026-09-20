/** 只接受实际类型，返回新对象，避免检查转换值后泄漏原始字符串。 */
export function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('应为对象')
  return value as Record<string, unknown>
}
export function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('应为字符串')
  return value
}
export function numberValue(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new Error('应为有效数字')
  return value
}
export function integerValue(value: unknown, minimum = 0): number {
  const number = numberValue(value, minimum)
  if (!Number.isSafeInteger(number)) throw new Error('应为安全整数')
  return number
}
export function identityValue(value: unknown): string {
  const identity = stringValue(value)
  if (!identity.trim()) throw new Error('身份标识不能为空')
  return identity
}
export function idValue(value: unknown): number {
  const id = numberValue(value, 1)
  if (!Number.isSafeInteger(id)) throw new Error('应为正整数 ID')
  return id
}
export function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('应为布尔值')
  return value
}
export function arrayValue<T>(value: unknown, read: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('应为数组')
  return value.map(read)
}
export function optional<T>(value: unknown, read: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : read(value)
}
export function mediaUrl(value: unknown): string {
  const text = stringValue(value)
  const url = new URL(text, 'https://radio.invalid')
  if (!['http:', 'https:'].includes(url.protocol) || (!/^https?:\/\//.test(text) && !/^\/api\/(audio|dj\/audio)\//.test(text))) throw new Error('无效音频地址')
  return text
}
