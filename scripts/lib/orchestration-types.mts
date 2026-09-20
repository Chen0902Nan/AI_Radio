import type { VerificationEnvironment } from './verification-environment.mts'
export interface Report { at: string; checks: { name: string; ok: boolean; detail?: unknown }[]; evidence: Record<string, unknown>; skipped?: { name: string }[]; summary?: { passed: number; failed: number }; fatal?: string }
export type Check = (name: string, ok: unknown, detail?: unknown) => void
export type Response = Record<string, unknown> & { status: number }
export type Request = VerificationEnvironment['request']
export interface Context { api: Request; post: (route: string, body?: unknown) => Promise<Response>; check: Check; report: Report }
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
export async function waitFor<T>(fn: () => T | Promise<T>, { timeout = 30000, interval = 100, label = 'condition' } = {}): Promise<Exclude<T, false | null | undefined | 0 | ''>> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value as Exclude<T, false | null | undefined | 0 | ''>
    await sleep(interval)
  }
  throw new Error(`等待超时：${label}`)
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('预期 HTTP 对象')
  return value as Record<string, unknown>
}
export function list(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('预期 HTTP 数组')
  return value.map(object)
}
export function sessionId(response: Response): string {
  const id = object(response.session).id
  if (typeof id !== 'string') throw new Error('会话缺少 id')
  return id
}
