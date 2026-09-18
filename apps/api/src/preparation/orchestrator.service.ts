/**
 * 节目编排层（迁移自 server/orchestrator.js）：
 * 把「候选抽样 → Codex 选歌 → 可播性校验 → 自动补歌协调」收敛到一处。
 *
 * 边界（对应 ADR-0003）：只负责「准备下一批可播内容」，不持有播放器，不操作 <audio>。
 * 队列本身仍在网页端；服务端只保证：同一会话同一意图不会并发生成多批、
 * 过期意图的结果会作废、停止的会话结果不会返回给下一次会话。
 *
 * 失败策略：Codex 失败降级为「从真实混合候选里挑可播的」，并记退避冷却（指数增长、有上限）；
 * 候选被排除后为空明确报 candidates_exhausted；音乐接口报错报 music_unavailable。
 */
import { Injectable } from '@nestjs/common'
import { NeteaseService, Track } from '../music/netease.service'
import { CodexService, CodexCandidate, CodexResult } from '../codex/codex.service'
import { DbService } from '../persistence/db.service'
import { DiscoverySelection } from './discovery-selection'
import { EventsService } from '../events/events.service'

export interface CheckedCandidate extends CodexCandidate {
  type: 'track'
  kind?: string
  playable: boolean
  error?: string | null
  reason?: string
  fromCodex?: boolean
}

function normalizeIdSet(ids?: unknown[]): Set<number> {
  const set = new Set<number>()
  for (const id of ids || []) {
    const n = Number(id)
    if (Number.isFinite(n)) set.add(n)
  }
  return set
}

export type PrepareResult = Record<string, unknown>

@Injectable()
export class OrchestratorService {
  // 每个会话同一时刻最多一个在途生成任务：重复请求复用同一个 Promise，不会重复调 Codex。
  private inflight = new Map<string, { epoch: number; promise: Promise<PrepareResult>; invalidated: boolean; startedAt: number }>()
  // 会话最新意图：任务完成不会让旧意图重新有效；只在会话结束时清除。
  private latestEpoch = new Map<string, number>()
  // Codex 失败后的退避冷却，避免紧密重试和额度空转。
  private cooldowns = new Map<string, { failures: number; until: number }>()

  constructor(
    private readonly ncm: NeteaseService,
    private readonly codex: CodexService,
    private readonly db: DbService,
    private readonly events: EventsService,
  ) {}

  /** 逐首做可播性二次校验：模型给的 id 只是候选，不能当作可播音源。 */
  async checkPlayable(items: Array<Partial<CodexCandidate>>): Promise<CheckedCandidate[]> {
    const out: CheckedCandidate[] = []
    for (const item of items) {
      let playable = false
      let kind = 'error'
      let error: string | null = null
      try {
        const info = await this.ncm.resolveTrack(item.id!)
        kind = info.kind
        playable = info.kind === 'full'
      } catch (err) {
        kind = 'error'
        error = (err as Error).message
      }
      out.push({ ...(item as CodexCandidate), type: 'track', kind, playable, error })
    }
    return out
  }

  isSessionOpen(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false
    try {
      const s = this.db.getSession(sessionId)
      return Boolean(s && !s.ended_at)
    } catch (_) {
      return false
    }
  }

  /** 会话停止/切换时调用：让在途任务的结果失效，并清掉该会话的冷却状态。 */
  invalidateSession(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false
    const entry = this.inflight.get(sessionId)
    if (entry) entry.invalidated = true
    this.inflight.delete(sessionId)
    this.latestEpoch.delete(sessionId)
    this.cooldowns.delete(sessionId)
    return Boolean(entry)
  }

  private cooldownState(sessionId: string): { failures: number; until: number } {
    return this.cooldowns.get(sessionId) || { failures: 0, until: 0 }
  }

  private noteCodexFailure(sessionId: string): { failures: number; until: number } {
    const base = this.db.getNumberSetting('codexFailureCooldownMs', 60000)
    const max = this.db.getNumberSetting('codexFailureCooldownMaxMs', 900000)
    const prev = this.cooldownState(sessionId)
    const failures = prev.failures + 1
    const until = Date.now() + Math.min(base * 2 ** (failures - 1), max)
    this.cooldowns.set(sessionId, { failures, until })
    return { failures, until }
  }

  /** 单个在途任务的真实生成流程。调用方已保证同一会话同一意图不会并发进入。 */
  private async runPrepare(opts: PrepareOptions, entry: { invalidated: boolean }): Promise<PrepareResult> {
    const started = Date.now()
    const {
      library,
      sessionId,
      excludeIds = [],
      count,
      brief = '',
      timeoutMs,
      skipCodex = false,
    } = opts
    const count_ = Math.max(1, Math.min(20, Math.floor(count || this.db.getNumberSetting('refillBatchSize', 5))))

    const superseded = () => ({
      ok: false,
      code: 'superseded',
      message: '已有更新的编排意图，本次补歌结果作废',
    })
    const ended = () => ({
      ok: false,
      code: 'session_ended',
      message: '收听会话已结束，本次补歌结果作废',
    })
    const checkAlive = () => {
      if (entry.invalidated) return superseded()
      if (!this.isSessionOpen(sessionId)) return ended()
      return null
    }

    const selection = new DiscoverySelection(this.ncm, this.db)
    const identity = this.ncm.currentIdentity()
    const pool = await selection.candidates(library || [], opts.libraryComplete === true, [...normalizeIdSet(excludeIds)], count_)
    if (opts.libraryMessage) pool.warnings.push(opts.libraryMessage)
    let dead = checkAlive()
    if (dead) return dead
    if (!pool.candidates.length) return {ok: false, code: 'candidates_exhausted', message: '没有可用候选，请调整歌单或稍后重试'}
    const inCooldown = Date.now() < this.cooldownState(sessionId).until
    let cr: CodexResult | null = null
    if (!skipCodex && !inCooldown) {
      cr = await this.codex.pickTracks({ candidates: pool.candidates, brief, count: Math.min(pool.candidates.length, count_ * 3), timeoutMs })
      if (cr.ok) this.cooldowns.delete(sessionId)
      else this.noteCodexFailure(sessionId)
    }
    dead = checkAlive()
    if (dead) return dead
    const result = await selection.pick(pool.candidates, cr?.ok ? cr.picks || [] : [], count_, pool.recent, () => !checkAlive() && identity === this.ncm.currentIdentity())
    dead = checkAlive()
    if (dead) return dead
    if (identity !== this.ncm.currentIdentity()) return {ok: false, code: 'superseded', message: '账号已切换，请重新准备'}
    if (!result.picks.length) return {ok: false, code: 'no_playable', message: '候选里没有完整可播歌曲', dropped: result.dropped}
    if (!cr?.ok) pool.warnings.push('Codex 暂不可用，已按口味候选继续选歌')
    if (result.discoveryUnavailable) pool.warnings.push('探索候选没有取得完整可播音源，先用歌单内歌曲续播')
    if (result.repeated) pool.warnings.push('可播候选不足，已放宽最近 50 首防重复限制')
    const picks = result.picks.filter(p => this.db.activeFeedbackMap().get(p.id) !== 'dislike')
    if (!picks.length) return {ok: false, code: 'candidates_exhausted', message: '候选已被标记为不喜欢，请重新准备'}
    return {ok: true, ...result, picks, source: cr?.ok ? 'codex' : 'library', degraded: pool.warnings.length > 0,
      message: [...new Set(pool.warnings)].join('；'), reason: cr?.ok ? (pool.warnings.length ? 'discovery_degraded' : undefined) : cr?.code || 'codex_skipped',
      meta: {durationMs: Date.now() - started, candidates: pool.candidates.length, codex: cr?.meta || {skipped: true}, targetDiscoveryRatio: 0.5}}
  }

  /**
   * 准备一批内容。
   *  - 同一 sessionId + 同一 epoch 的重复请求：复用同一个在途 Promise，不会重复调用。
   *  - 同一 sessionId + 更大的 epoch：旧任务标记作废，新任务立即开始。
   *  - 同一 sessionId + 更小的 epoch（乱序到达的旧请求）：直接拒绝，不影响在途的新任务。
   *  - 会话已结束：直接拒绝，不产生结果。
   */
  async prepareBatch(opts: Partial<PrepareOptions> = {}): Promise<PrepareResult> {
    const sessionId = opts.sessionId as string
    const epoch = Number(opts.epoch) || 0

    if (!this.isSessionOpen(sessionId)) {
      return { ok: false, code: 'session_ended', message: '没有进行中的收听会话，补歌请求已忽略' }
    }

    const latest = this.latestEpoch.get(sessionId)
    if (latest !== undefined && epoch < latest) {
      return {
        ok: false,
        code: 'superseded',
        message: `补歌请求已过期（epoch ${epoch} 早于会话最新的 ${latest}）`,
      }
    }

    const existing = this.inflight.get(sessionId)
    if (existing) {
      if (existing.epoch === epoch) {
        const result = await existing.promise
        return { ...result, deduped: true }
      }
      // epoch 更大才是「新意图取代旧任务」
      existing.invalidated = true
      this.inflight.delete(sessionId)
    }

    this.latestEpoch.set(sessionId, epoch)
    const entry = { epoch, invalidated: false, startedAt: Date.now(), promise: null as unknown as Promise<PrepareResult> }
    const promise = this.runPrepare(opts as PrepareOptions, entry).catch((err) => ({
      ok: false,
      code: 'internal_error',
      message: String((err && (err as Error).message) || err),
    }))
    entry.promise = promise
    this.inflight.set(sessionId, entry)
    try {
      const result = await promise
      // SSE 通知：补歌批次结果（批次交付仍以 POST 响应为唯一途径，事件仅提示刷新状态）
      this.events.publish({
        type: 'refill-status',
        sessionId,
        epoch,
        state: result.ok ? 'done' : 'failed',
        code: (result.code as string) ?? undefined,
        message: (result.message as string) ?? undefined,
        degraded: Boolean((result as { degraded?: boolean }).degraded),
      })
      return result
    } finally {
      if (this.inflight.get(sessionId) === entry) {
        this.inflight.delete(sessionId)
      }
    }
  }

  inflightInfo(): Array<{ sessionId: string; epoch: number; startedAt: number }> {
    return [...this.inflight.entries()].map(([sessionId, e]) => ({
      sessionId,
      epoch: e.epoch,
      startedAt: e.startedAt,
    }))
  }
}

export interface PrepareOptions {
  library: Track[]
  libraryComplete?: boolean
  libraryMessage?: string
  sessionId: string
  epoch: number
  excludeIds?: unknown[]
  count?: number
  brief?: string
  timeoutMs?: number
  skipCodex?: boolean
  rand?: () => number
}
