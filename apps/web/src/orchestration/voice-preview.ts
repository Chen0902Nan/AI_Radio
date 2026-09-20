/** 音色草稿、合成请求与试听保存资格共享身份；声音仍由唯一播放器执行。 */
interface PreviewResponse { ok: boolean; status?: number; code?: unknown; message?: unknown; audio?: { url: string; durationMs: number } }
interface PreviewDependencies {
  request: (voice: string) => Promise<PreviewResponse>
  isListening: () => boolean
  play: (url: string) => Promise<boolean>
  cancel: () => void
  save: (voice: string) => Promise<boolean>
}
export interface VoicePreviewSnapshot { voice: string; status: string | null; canSave: boolean }
export class VoicePreviewController {
  private state: VoicePreviewSnapshot = { voice: '', status: null, canSave: false }
  private listeners = new Set<() => void>()
  private generation = 0
  private edited = false
  constructor(private readonly dependencies: PreviewDependencies) {}
  getSnapshot = (): VoicePreviewSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(patch: Partial<VoicePreviewSnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  initialize(voice: string): void {
    if (!this.edited) this.update({ voice })
  }
  edit(voice: string): void {
    this.edited = true
    this.stop()
    this.update({ voice, status: null })
  }
  stop = (): void => {
    this.generation += 1
    this.dependencies.cancel()
    this.update({ canSave: false, status: null })
  }
  private requestedVoice(): string | null {
    if (this.dependencies.isListening()) { this.update({ status: '停止收听后才能试听音色，避免打断节目。' }); return null }
    const voice = this.state.voice.trim()
    if (voice) return voice
    this.update({ status: '先填写要试听的音色 reference_id。' })
    return null
  }
  private failed(result: PreviewResponse): void {
    this.update({ status: `试听失败（${result.code || result.status}）：${result.message || ''}` })
  }
  async preview(): Promise<void> {
    this.stop()
    const generation = this.generation
    const voice = this.requestedVoice()
    if (!voice) return
    this.update({ status: '正在合成试听…' })
    try {
      const result = await this.dependencies.request(voice)
      if (!this.current(generation)) return
      if (!result.ok || !result.audio) {
        this.failed(result)
        return
      }
      const success = await this.dependencies.play(result.audio.url)
      if (!this.current(generation)) return
      this.update({ canSave: success, status: success
        ? `试听播放中（约 ${(result.audio.durationMs / 1000).toFixed(1)} 秒）。满意就点「设为正式音色」。`
        : '试听播放失败，请重试。' })
    } catch (error) {
      if (this.current(generation)) this.update({ status: '试听播放失败：' + String(error instanceof Error ? error.message : error) })
    }
  }
  private current(generation: number): boolean {
    return generation === this.generation && !this.dependencies.isListening()
  }
  async saveChosen(): Promise<boolean> {
    if (!this.state.canSave) return false
    const generation = this.generation
    const voice = this.state.voice.trim()
    const success = await this.dependencies.save(voice)
    if (!this.current(generation)) return success
    this.update({ canSave: !success, status: success ? `已把 ${voice} 设为正式音色，之后的串场都会用它。` : '设置保存失败，请重试。' })
    return success
  }
}
