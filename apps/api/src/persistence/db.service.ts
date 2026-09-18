/**
 * SQLite 持久化（迁移自 server/db.js，保持 node:sqlite、原 schema、原函数语义）。
 * 四类表：settings / feedback / sessions / plays。
 * 设计约束不变：反馈可撤销（revoked_at 标记）、同曲一条生效反馈（部分唯一索引）、
 * 收听会话由服务端持有。
 */
import { Injectable, OnModuleInit } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DB_FILE } from '../config/app-config'

const DEFAULT_SETTINGS: Record<string, string> = {
  candidateCount: '60', // 送给 Codex 的候选数量
  pickCount: '5', // 让 Codex 选几首
  feedbackLikeBoost: '2.0', // 历史设置兼容保留；探索策略不再提高原歌重播权重
  feedbackDislikePenalty: '0.1', // 历史设置兼容保留；探索策略始终排除不喜欢版本
  avoidRepeatWindowMin: '45', // 历史设置兼容保留；探索策略采用最近 50 首自动歌曲
  // —— 自动补歌参数（默认值依据见 .scratch/radio-agent/verification/report.md）——
  refillThreshold: '2', // 待播剩多少首开始后台补歌
  refillBatchSize: '5', // 每批补多少首
  refillBackoffBaseMs: '30000', // 补歌失败后的首次重试间隔（指数退避起点）
  refillBackoffMaxMs: '300000', // 退避上限
  refillMaxAttempts: '5', // 同一轮失败最多自动重试几次，之后等待用户动作
  codexFailureCooldownMs: '60000', // Codex 失败后跳过订阅、改用曲库候选的冷却起点
  codexFailureCooldownMaxMs: '900000', // 冷却上限
  // —— DJ 串场（Q9 确认基线；密钥只来自服务启动环境，不入库）——
  djEnabled: 'true', // 关闭后继续纯音乐
  djIntervalTracks: '4', // 每自然播完几首安排一次，可选 3/4/5
  djVoiceReferenceId: '', // 试听后由用户选定；空 = 语音不可用
  fishModel: 's2.1-pro-free', // 固定免费模型；配置成其他值会被拒绝，不回落付费
}

@Injectable()
export class DbService implements OnModuleInit {
  private db!: DatabaseSync

  onModuleInit(): void {
    if (this.db) return
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
    this.db = new DatabaseSync(DB_FILE)
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id   INTEGER NOT NULL,
        track_name TEXT,
        artists    TEXT,
        sentiment  TEXT NOT NULL CHECK (sentiment IN ('like','dislike')),
        source     TEXT NOT NULL DEFAULT 'ui',
        session_id TEXT,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS feedback_active_unique
        ON feedback(track_id) WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        end_reason  TEXT,
        adjustments TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS plays (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        track_id   INTEGER NOT NULL,
        track_name TEXT,
        artists    TEXT,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        outcome    TEXT
      );
    `)
    this.db.exec(`CREATE TABLE IF NOT EXISTS selections (
      id TEXT PRIMARY KEY, track_id INTEGER NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL
    )`)
    const columns = new Set((this.db.prepare('PRAGMA table_info(plays)').all() as Array<{name: string}>).map(c => c.name))
    for (const column of ['play_instance_id', 'selection_source']) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE plays ADD COLUMN ${column} TEXT`)
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS plays_instance_unique ON plays(play_instance_id) WHERE play_instance_id IS NOT NULL')
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      this.db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(k, v, Date.now())
    }
  }

  private get db_(): DatabaseSync {
    this.onModuleInit()
    return this.db
  }

  /* ---------- 设置 ---------- */

  listSettings(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const row of this.db_.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>) {
      out[row.key] = row.value
    }
    return out
  }

  getSetting(key: string, fallback: string | null = null): string | null {
    const row = this.db_.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? row.value : fallback
  }

  getNumberSetting(key: string, fallback: number): number {
    const n = Number(this.getSetting(key, fallback as unknown as string))
    return Number.isFinite(n) ? n : fallback
  }

  setSetting(key: string, value: unknown): { key: string; value: string } {
    this.db_
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, String(value), Date.now())
    return { key, value: String(value) }
  }

  /* ---------- 喜好反馈 ---------- */

  /** 记录显式反馈。同一首歌的新反馈会先撤销旧的生效反馈。 */
  addFeedback({ trackId, trackName, artists, sentiment, source = 'ui', sessionId = null }: {
    trackId: number
    trackName?: string | null
    artists?: string | null
    sentiment: string
    source?: string
    sessionId?: string | null
  }): Record<string, unknown> {
    if (sentiment !== 'like' && sentiment !== 'dislike') {
      throw new Error(`无效的反馈类型：${sentiment}`)
    }
    const ts = Date.now()
    this.db_.prepare('UPDATE feedback SET revoked_at = ? WHERE track_id = ? AND revoked_at IS NULL').run(ts, trackId)
    this.db_
      .prepare('INSERT INTO feedback (track_id, track_name, artists, sentiment, source, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(trackId, trackName || null, artists || null, sentiment, source, sessionId, ts)
    return this.getActiveFeedback(trackId)!
  }

  revokeFeedback(trackId: number): Record<string, unknown> {
    const before = this.getActiveFeedback(trackId)
    if (!before) return { revoked: false, trackId }
    this.db_.prepare('UPDATE feedback SET revoked_at = ? WHERE track_id = ? AND revoked_at IS NULL').run(Date.now(), trackId)
    return { revoked: true, trackId, previous: before }
  }

  getActiveFeedback(trackId: number): Record<string, unknown> | null {
    return (
      (this.db_
        .prepare('SELECT id, track_id, track_name, artists, sentiment, source, session_id, created_at FROM feedback WHERE track_id = ? AND revoked_at IS NULL')
        .get(trackId) as Record<string, unknown> | undefined) || null
    )
  }

  listFeedback({ includeRevoked = false } = {}): Array<Record<string, unknown>> {
    const sql = includeRevoked
      ? 'SELECT * FROM feedback ORDER BY created_at DESC'
      : 'SELECT * FROM feedback WHERE revoked_at IS NULL ORDER BY created_at DESC'
    return this.db_.prepare(sql).all() as Array<Record<string, unknown>>
  }

  /** 生效反馈的 id -> sentiment 映射，供选歌加权用。 */
  activeFeedbackMap(): Map<number, string> {
    const map = new Map<number, string>()
    for (const row of this.db_.prepare('SELECT track_id, sentiment FROM feedback WHERE revoked_at IS NULL').all() as Array<{ track_id: number; sentiment: string }>) {
      map.set(Number(row.track_id), row.sentiment)
    }
    return map
  }

  feedbackSummary(): { like: number; dislike: number } {
    const rows = this.db_
      .prepare("SELECT sentiment, COUNT(*) AS n FROM feedback WHERE revoked_at IS NULL GROUP BY sentiment")
      .all() as Array<{ sentiment: string; n: number }>
    const out: Record<string, number> = { like: 0, dislike: 0 }
    for (const r of rows) out[r.sentiment] = r.n
    return { like: out.like, dislike: out.dislike }
  }

  /* ---------- 收听会话 ---------- */

  startSession(): Record<string, unknown> {
    const open = this.getOpenSession()
    if (open) return { ...open, reused: true }
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.db_.prepare('INSERT INTO sessions (id, started_at, adjustments) VALUES (?, ?, ?)').run(id, Date.now(), '{}')
    return { ...this.getSession(id)!, reused: false }
  }

  getSession(id: string): Record<string, unknown> | null {
    const row = this.db_.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return { ...row, adjustments: safeParse(row.adjustments as string) }
  }

  getOpenSession(): Record<string, unknown> | null {
    const row = this.db_.prepare('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get() as Record<string, unknown> | undefined
    if (!row) return null
    return { ...row, adjustments: safeParse(row.adjustments as string) }
  }

  /** 停止收听：结束会话并清空本次的临时调整（下次开播恢复个人默认）。 */
  endSession(reason = 'stopped'): Record<string, unknown> {
    const open = this.getOpenSession()
    if (!open) return { ended: false }
    this.db_.prepare('UPDATE sessions SET ended_at = ?, end_reason = ?, adjustments = ? WHERE id = ?').run(Date.now(), reason, '{}', open.id as string)
    return { ended: true, id: open.id, reason, adjustments: open.adjustments }
  }

  /**
   * 启动时收尾：服务重启后，上一条开着但没有心跳的会话不再视为进行中。
   * 这里不删数据，只补上结束时间与原因，便于回溯。
   */
  closeStaleSessions(reason = 'server_restart'): { closed: number; id?: string } {
    const open = this.getOpenSession()
    if (!open) return { closed: 0 }
    this.db_.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(Date.now(), reason, open.id as string)
    return { closed: 1, id: open.id as string }
  }

  setAdjustment(sessionId: string, key: string, value: unknown): Record<string, string> {
    const s = this.getSession(sessionId)
    if (!s || s.ended_at) throw new Error('会话不存在或已结束')
    const next = { ...(s.adjustments as Record<string, string>) }
    if (value === null || value === undefined || value === '') delete next[key]
    else next[key] = String(value)
    this.db_.prepare('UPDATE sessions SET adjustments = ? WHERE id = ?').run(JSON.stringify(next), sessionId)
    return next
  }

  /* ---------- 播放记录 ---------- */

  recordPlay({ sessionId = null, trackId, trackName, artists, playInstanceId = null, selectionId = null }: {
    selectionId?: string | null
    playInstanceId?: string | null
    sessionId?: string | null
    trackId: number
    trackName?: string | null
    artists?: string | null
  }): number {
    if (playInstanceId) {
      const existing = this.db_.prepare('SELECT id FROM plays WHERE play_instance_id = ?').get(playInstanceId) as { id: number } | undefined
      if (existing) return existing.id
    }
    const selection = selectionId && playInstanceId ? this.db_.prepare('SELECT source FROM selections WHERE id = ? AND track_id = ?').get(selectionId, trackId) as {source: string} | undefined : null
    const res = this.db_
      .prepare('INSERT INTO plays (session_id, track_id, track_name, artists, started_at, play_instance_id, selection_source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, trackId, trackName || null, artists || null, Date.now(), playInstanceId, selection?.source || null)
    return Number(res.lastInsertRowid)
  }

  finishPlay(playId: number, outcome: string): void {
    if (!playId) return
    this.db_.prepare('UPDATE plays SET ended_at = ?, outcome = ? WHERE id = ?').run(Date.now(), outcome, playId)
  }

  recentPlays(limit = 50): Array<Record<string, unknown>> {
    return this.db_.prepare('SELECT * FROM plays ORDER BY started_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
  }

  registerSelection(trackId: number, source: 'library' | 'discovery'): string {
    const id = randomUUID()
    this.db_.prepare('INSERT INTO selections (id, track_id, source, created_at) VALUES (?, ?, ?, ?)').run(id, trackId, source, Date.now())
    return id
  }

  automaticHistory(): Array<{ track_id: number; selection_source: 'library' | 'discovery' }> {
    return this.db_.prepare("SELECT track_id, selection_source FROM plays WHERE selection_source IN ('library', 'discovery') ORDER BY id DESC LIMIT 50").all() as Array<{ track_id: number; selection_source: 'library' | 'discovery' }>
  }

  /** 最近播放过的曲目 id，供选歌避免短时间重复。 */
  recentlyPlayedIds(withinMs: number): number[] {
    const since = Date.now() - withinMs
    return (this.db_.prepare('SELECT DISTINCT track_id FROM plays WHERE started_at >= ?').all(since) as Array<{ track_id: number }>).map((r) => Number(r.track_id))
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) || {}
  } catch (_) {
    return {}
  }
}
