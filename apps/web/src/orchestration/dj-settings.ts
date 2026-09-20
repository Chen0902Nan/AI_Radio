/** 唯一的 DJ 配置入口：保存串行，读取按修改版本作废，失败恢复已确认状态。 */
export interface DjVoice { ready: boolean; code: string | null; message: string; voiceReferenceId: string | null }
export interface SettingsResponse { ok: boolean; status?: number; message?: unknown; settings?: Record<string, string>; djVoice?: DjVoice | null }
export interface DjSettingsSnapshot { settings: Record<string, string>; djVoice: DjVoice | null; error: string | null; saving: boolean }
interface SettingsDependencies {
  read: () => Promise<SettingsResponse>
  save: (key: string, value: string) => Promise<SettingsResponse>
  apply: (config: { djEnabled: boolean; djIntervalTracks: number; voiceConfigUpdated: boolean }) => void
}
interface SaveRequest { key: string; value: string; resolve: (ok: boolean) => void }

export class DjSettingsController {
  private state: DjSettingsSnapshot = { settings: {}, djVoice: null, error: null, saving: false }
  private confirmed: Record<string, string> = {}
  private listeners = new Set<() => void>()
  private revision = 0
  private readSequence = 0
  private queue: SaveRequest[] = []
  private refreshPending = false
  constructor(private readonly dependencies: SettingsDependencies) {}
  getSnapshot = (): DjSettingsSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(patch: Partial<DjSettingsSnapshot>): void {
    const previous = this.state
    this.state = { ...previous, ...patch }
    const voice = this.state.djVoice
    this.dependencies.apply({
      djEnabled: this.state.settings.djEnabled !== 'false',
      djIntervalTracks: Number(this.state.settings.djIntervalTracks) || 4,
      voiceConfigUpdated: previous.djVoice?.voiceReferenceId !== voice?.voiceReferenceId || previous.djVoice?.ready !== voice?.ready,
    })
    for (const listener of this.listeners) listener()
  }
  private visibleSettings(): Record<string, string> {
    const settings = { ...this.confirmed }
    for (const request of this.queue) settings[request.key] = request.value
    return settings
  }
  private currentRead(revision: number, sequence: number): boolean {
    return revision === this.revision && sequence === this.readSequence
  }
  async refresh(): Promise<void> {
    if (this.queue.length) { this.refreshPending = true; return }
    const revision = this.revision
    const sequence = ++this.readSequence
    try {
      const result = await this.dependencies.read()
      if (!this.currentRead(revision, sequence)) return
      if (!result.ok) throw new Error(String(result.message || '无法读取 DJ 设置'))
      this.confirmed = result.settings ?? {}
      this.publish({ settings: this.confirmed, djVoice: result.djVoice ?? null })
    } catch (error) {
      if (this.currentRead(revision, sequence)) this.publish({ error: String(error instanceof Error ? error.message : error) })
    }
  }
  save(key: string, value: string): Promise<boolean> {
    this.revision += 1
    const wasIdle = this.queue.length === 0
    const result = new Promise<boolean>(resolve => { this.queue.push({ key, value, resolve }) })
    this.publish({ settings: this.visibleSettings(), saving: true, error: null })
    if (wasIdle) void this.flush()
    return result
  }
  private async flush(): Promise<void> {
    while (this.queue.length) await this.saveFirst()
    if (this.refreshPending) { this.refreshPending = false; await this.refresh() }
  }
  private async saveFirst(): Promise<void> {
    const request = this.queue[0]
    let success = false
    let voice = this.state.djVoice
    let error: string | null = null
    try {
      const result = await this.dependencies.save(request.key, request.value)
      if (!result.ok) throw new Error(String(result.message || `HTTP ${result.status}`))
      this.confirmed = result.settings ?? { ...this.confirmed, [request.key]: request.value }
      voice = result.djVoice ?? voice
      success = true
    } catch (cause) { error = '设置保存失败：' + String(cause instanceof Error ? cause.message : cause) }
    this.queue.shift()
    this.publish({ settings: this.visibleSettings(), djVoice: voice, error, saving: this.queue.length > 0 })
    request.resolve(success)
  }
  invalidateReads(): void { this.readSequence += 1 }
}
