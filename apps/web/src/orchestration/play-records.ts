import type { TrackItem, SessionInfo } from '@radio/contracts'
import { api } from '../api/client'
interface PlayingRecord { id: number | null; outcome: string | null }
interface RecordDependencies {
  sessionId: () => string | null
  onClosed: () => void
  onStarted: (playId: number, session: SessionInfo) => void
}
/** 延迟的记账响应只收尾自己的记录，不能恢复已结束的会话。 */
export class PlayRecords {
  private active: PlayingRecord | null = null
  constructor(private readonly dependencies: RecordDependencies) {}
  close(outcome: string): void {
    const record = this.active
    if (!record) return
    this.active = null
    record.outcome = outcome
    this.dependencies.onClosed()
    if (record.id !== null) void api.playEnd(record.id, outcome).catch(() => {})
  }
  async start(item: TrackItem | null, playInstanceId: string): Promise<void> {
    if (!item) return
    const record: PlayingRecord = { id: null, outcome: null }
    this.active = record
    try {
      const data = await api.playStart({ trackId: item.trackId, trackName: item.name, artists: item.artists,
        sessionId: this.dependencies.sessionId(), playInstanceId, selectionId: item.auto ? item.selectionId : undefined })
      if (!data.ok) return
      record.id = data.playId
      if (record.outcome) { await api.playEnd(record.id, record.outcome); return }
      if (this.active !== record) return
      this.dependencies.onStarted(record.id, data.session)
    } catch { /* 记账失败不能改变播放意图。 */ }
  }
}
