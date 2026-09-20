interface Notice { seq: number; type: string; sessionId?: unknown; epoch?: unknown; segueId?: unknown; transitionId?: unknown }
interface EventDependencies {
  context: () => { sessionId: string | null; epoch: number }
  refreshSettings: () => void
  opened: () => void
  disconnected: () => void
  released: () => void
  notice: (notice: Notice) => void
}
function parseNotice(data: string): Notice | null {
  const value: unknown = JSON.parse(data)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (message.v !== 1 || typeof message.seq !== 'number' || !Number.isSafeInteger(message.seq)) return null
  if (typeof message.type !== 'string') return null
  return { ...message, seq: message.seq, type: message.type }
}
/** 引用计数保证 StrictMode 重建连接时旧事件失效，序号只属于当前连接。 */
export class RadioEvents {
  private source: EventSource | null = null
  private connections = 0
  private lastSequence = 0
  constructor(private readonly dependencies: EventDependencies) {}
  connect = (): (() => void) => {
    this.connections += 1
    if (this.connections === 1) this.dependencies.refreshSettings()
    if (!this.source && typeof EventSource !== 'undefined') this.open()
    let released = false
    return () => {
      if (released) return
      released = true
      this.connections -= 1
      if (this.connections !== 0) return
      this.source?.close()
      this.source = null
      this.dependencies.released()
    }
  }
  private open(): void {
    const source = new EventSource('/api/events')
    this.source = source
    source.addEventListener('open', () => {
      if (this.source !== source) return
      this.lastSequence = 0
      this.dependencies.opened()
    })
    source.addEventListener('error', () => {
      if (this.source === source) this.dependencies.disconnected()
    })
    source.addEventListener('event', (event: MessageEvent<string>) => {
      if (this.source === source) this.receive(event.data)
    })
  }
  private applies(message: Notice): boolean {
    const context = this.dependencies.context()
    if (message.sessionId && message.sessionId !== context.sessionId) return false
    return message.epoch === undefined || message.epoch === context.epoch
  }
  private receive(data: string): void {
    try {
      const message = parseNotice(data)
      if (!message || message.seq <= this.lastSequence || !this.applies(message)) return
      this.lastSequence = message.seq
      this.dependencies.notice(message)
    } catch { /* 无效事件不是播放指令。 */ }
  }
}
