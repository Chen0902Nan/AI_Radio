/** 一轮二维码请求、轮询和跳转共用同一个可取消生命周期。 */
export interface LoginSnapshot { qrImg: string | null; status: string }
interface LoginDependencies {
  request: (path: string, signal: AbortSignal) => Promise<unknown>
  navigate: () => void
  pollIntervalMs?: number
  refreshMs?: number
  redirectMs?: number
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('登录服务返回的数据不完整，请稍后重试。')
  return value as Record<string, unknown>
}

function qrCode(value: Record<string, unknown>): { key: string; qrimg: string } {
  if (typeof value.key !== 'string' || !value.key || typeof value.qrimg !== 'string' || !value.qrimg) {
    throw new Error('登录服务返回的数据不完整，请稍后重试。')
  }
  return { key: value.key, qrimg: value.qrimg }
}

export class LoginLifecycle {
  private state: LoginSnapshot = { qrImg: null, status: '正在获取二维码…' }
  private listeners = new Set<() => void>()
  private generation = 0
  private abort: AbortController | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()
  constructor(private readonly dependencies: LoginDependencies) {}
  getSnapshot = (): LoginSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(patch: Partial<LoginSnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  dispose = (): void => {
    this.generation += 1
    this.abort?.abort()
    this.abort = null
    this.clearTimers()
  }
  private schedule(generation: number, delay: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (generation === this.generation) action()
    }, delay)
    this.timers.add(timer)
  }
  async start(reason?: string): Promise<void> {
    this.dispose()
    const generation = this.generation
    const abort = new AbortController()
    this.abort = abort
    this.update({ qrImg: null, status: reason ? reason + '，正在获取新二维码…' : '正在获取二维码…' })
    try {
      const value = await this.dependencies.request('/api/login/qr', abort.signal)
      if (generation !== this.generation) return
      const data = qrCode(object(value))
      this.update({ qrImg: data.qrimg, status: '请用网易云音乐 App 扫码，并在手机上确认登录。' })
      this.schedulePoll(generation, data.key, abort.signal)
      this.schedule(generation, this.dependencies.refreshMs ?? 240000, () => { void this.start('二维码即将过期') })
    } catch (error) {
      if (generation === this.generation) this.update({ status: '获取二维码失败：' + String(error instanceof Error ? error.message : error) })
    }
  }
  private schedulePoll(generation: number, key: string, signal: AbortSignal): void {
    this.schedule(generation, this.dependencies.pollIntervalMs ?? 2500, () => { void this.poll(generation, key, signal) })
  }
  private async poll(generation: number, key: string, signal: AbortSignal): Promise<void> {
    try {
      const data = object(await this.dependencies.request('/api/login/poll?key=' + encodeURIComponent(key), signal))
      if (generation !== this.generation) return
      if (data.code === 800) { await this.start('二维码已过期'); return }
      if (data.code === 803) { this.succeed(generation, data); return }
      if (data.code === 802) this.update({ status: '已扫码，请在手机上确认。' })
    } catch { /* 临时断网仍重试，但失效的一轮不得重新安排计时器。 */ }
    if (generation === this.generation) this.schedulePoll(generation, key, signal)
  }
  private succeed(generation: number, data: Record<string, unknown>): void {
    const account = data.account && typeof data.account === 'object' ? object(data.account) : null
    const nickname = typeof account?.nickname === 'string' ? account.nickname : ''
    this.clearTimers()
    this.update({ status: `登录成功：${nickname}，3 秒后返回播放器…` })
    this.schedule(generation, this.dependencies.redirectMs ?? 3000, this.dependencies.navigate)
  }
}
