import type { ApiResult, DjJobInfo } from '@radio/contracts'
import type { PrepareRequestPayload } from './segue-controller'
const SEGUE_POLL_MS = 2000
const SEGUE_POLL_DEADLINE_MS = 170000
export type WatchedJobResult = DjJobInfo & { reason?: string }
interface WatchDependencies {
  current: (request: PrepareRequestPayload) => boolean
  connected: () => boolean
  cancel: (id: string, reason: string) => Promise<unknown>
  read: (id: string) => Promise<ApiResult<{ job: DjJobInfo }>>
}

/** 每个任务独占查询状态和两个计时器；完成或离开统一收尾。 */
class JobWatch {
  private done = false
  private querying = false
  private refreshAgain = false
  private poll: ReturnType<typeof setTimeout> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  constructor(
    readonly req: PrepareRequestPayload,
    private readonly initial: WatchedJobResult,
    private readonly dependencies: WatchDependencies,
    private readonly resolve: (result: WatchedJobResult) => void,
  ) {}
  start(): void {
    this.deadline = setTimeout(() => this.finish({ ...this.initial, state: 'unavailable', code: 'timeout', message: '串场准备超时，继续音乐。' }), SEGUE_POLL_DEADLINE_MS)
    this.reconcile()
    // 关闭 prepare 响应与注册订阅之间的通知丢失窗口。
    if (!this.done) void this.refresh()
  }
  private finish(result: WatchedJobResult): void {
    if (this.done) return
    this.done = true
    if (this.poll) clearTimeout(this.poll)
    if (this.deadline) clearTimeout(this.deadline)
    this.resolve(result)
  }
  cancel(reason = 'unmounted'): void {
    if (this.done) return
    void this.dependencies.cancel(this.initial.segueId, reason).catch(() => {})
    this.finish({ ...this.initial, state: 'stale', reason })
  }
  reconcile(): void {
    if (this.done) return
    if (!this.dependencies.current(this.req)) { this.cancel('superseded'); return }
    if (this.dependencies.connected()) {
      if (this.poll) clearTimeout(this.poll)
      this.poll = null
    } else if (!this.poll && !this.querying) {
      this.poll = setTimeout(() => { this.poll = null; void this.refresh() }, SEGUE_POLL_MS)
    }
  }
  private accept(result: ApiResult<{ job: DjJobInfo }>): void {
    if (result.ok) {
      if (result.job.segueId === this.initial.segueId && result.job.state !== 'preparing') this.finish(result.job)
    } else if (result.status === 404) this.finish({ ...this.initial, state: 'stale', reason: 'expired' })
  }
  async refresh(): Promise<void> {
    if (this.done) return
    if (this.querying) { this.refreshAgain = true; return }
    this.reconcile()
    if (this.done) return
    this.querying = true
    try {
      const result = await this.dependencies.read(this.initial.segueId)
      if (this.done || !this.dependencies.current(this.req)) return
      this.accept(result)
    } catch { /* 断线暂时不可查，保留任务至总截止。 */ }
    finally {
      this.querying = false
      this.reconcile()
      if (this.refreshAgain && !this.done) { this.refreshAgain = false; void this.refresh() }
    }
  }
}

export class DjJobWatcher {
  private readonly jobs = new Map<string, JobWatch>()
  constructor(private readonly dependencies: WatchDependencies) {}
  get(id: string): JobWatch | undefined { return this.jobs.get(id) }
  reconcile(): void { for (const job of this.jobs.values()) job.reconcile() }
  refresh(): void { for (const job of this.jobs.values()) { job.reconcile(); void job.refresh() } }
  cancel(): void { for (const job of this.jobs.values()) job.cancel() }
  wait(req: PrepareRequestPayload, initial: WatchedJobResult): Promise<WatchedJobResult> {
    if (initial.state !== 'preparing') return Promise.resolve(initial)
    return new Promise(resolve => {
      const watch = new JobWatch(req, initial, this.dependencies, result => {
        this.jobs.delete(initial.segueId)
        resolve(result)
      })
      this.jobs.set(initial.segueId, watch)
      watch.start()
    })
  }
}
