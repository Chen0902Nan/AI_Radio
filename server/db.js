/**
 * 本地持久化（SQLite，用 Node 内置的 node:sqlite，不引入原生依赖）。
 *
 * 按规格保存四类东西：可调设置、显式喜好反馈、收听会话、必要的播放记录。
 * 设计约束：
 *  - 反馈可撤销：撤销是标记 revoked_at，不物理删除，便于回溯。
 *  - 同一首歌同一时刻只有一条生效反馈（部分唯一索引保证）。
 *  - 反馈只作用于单曲，不据此封禁整个歌手或风格。
 *  - 收听会话由服务端持有：网页刷新只是重新连上，不会新建会话或重复播放任务。
 */
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const DATA_DIR = path.resolve(__dirname, '..', 'data')
const DB_FILE = process.env.RADIO_DB_FILE || path.join(DATA_DIR, 'radio.db')

let db = null

const DEFAULT_SETTINGS = {
  candidateCount: '60', // 送给 Codex 的候选数量
  pickCount: '5', // 让 Codex 选几首
  feedbackLikeBoost: '2.0', // 喜欢的候选权重倍数
  feedbackDislikePenalty: '0.1', // 不喜欢的候选权重倍数（降低而不封禁）
  avoidRepeatWindowMin: '45', // 这段时间内播过的歌在选歌时降权
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
  djVoiceReferenceId: '', // 任务 07 试听后由用户选定；空 = 语音不可用
  fishModel: 's2.1-pro-free', // 固定免费模型；配置成其他值会被拒绝，不回落付费
}

function init() {
  if (db) return db
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
  db = new DatabaseSync(DB_FILE)
  db.exec(`
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
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    db.prepare(
      'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run(k, v, Date.now())
  }
  return db
}

const now = () => Date.now()

/* ---------- 设置 ---------- */

function listSettings() {
  init()
  const out = {}
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value
  return out
}

function getSetting(key, fallback = null) {
  init()
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : fallback
}

function getNumberSetting(key, fallback) {
  const n = Number(getSetting(key, fallback))
  return Number.isFinite(n) ? n : fallback
}

function setSetting(key, value) {
  init()
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, String(value), now())
  return { key, value: String(value) }
}

/* ---------- 喜好反馈 ---------- */

/**
 * 记录显式反馈。同一首歌的新反馈会先撤销旧的生效反馈，
 * 保证「可撤销」和「同一时刻只有一条生效」。
 */
function addFeedback({ trackId, trackName, artists, sentiment, source = 'ui', sessionId = null }) {
  init()
  if (sentiment !== 'like' && sentiment !== 'dislike') {
    throw new Error(`无效的反馈类型：${sentiment}`)
  }
  const ts = now()
  db.prepare('UPDATE feedback SET revoked_at = ? WHERE track_id = ? AND revoked_at IS NULL').run(
    ts,
    trackId,
  )
  db.prepare(
    'INSERT INTO feedback (track_id, track_name, artists, sentiment, source, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(trackId, trackName || null, artists || null, sentiment, source, sessionId, ts)
  return getActiveFeedback(trackId)
}

function revokeFeedback(trackId) {
  init()
  const before = getActiveFeedback(trackId)
  if (!before) return { revoked: false, trackId }
  db.prepare('UPDATE feedback SET revoked_at = ? WHERE track_id = ? AND revoked_at IS NULL').run(
    now(),
    trackId,
  )
  return { revoked: true, trackId, previous: before }
}

function getActiveFeedback(trackId) {
  init()
  return (
    db
      .prepare(
        'SELECT id, track_id, track_name, artists, sentiment, source, session_id, created_at FROM feedback WHERE track_id = ? AND revoked_at IS NULL',
      )
      .get(trackId) || null
  )
}

function listFeedback({ includeRevoked = false } = {}) {
  init()
  const sql = includeRevoked
    ? 'SELECT * FROM feedback ORDER BY created_at DESC'
    : 'SELECT * FROM feedback WHERE revoked_at IS NULL ORDER BY created_at DESC'
  return db.prepare(sql).all()
}

/** 生效反馈的 id -> sentiment 映射，供选歌加权用。 */
function activeFeedbackMap() {
  init()
  const map = new Map()
  for (const row of db.prepare('SELECT track_id, sentiment FROM feedback WHERE revoked_at IS NULL').all()) {
    map.set(Number(row.track_id), row.sentiment)
  }
  return map
}

function feedbackSummary() {
  init()
  const rows = db
    .prepare(
      "SELECT sentiment, COUNT(*) AS n FROM feedback WHERE revoked_at IS NULL GROUP BY sentiment",
    )
    .all()
  const out = { like: 0, dislike: 0 }
  for (const r of rows) out[r.sentiment] = r.n
  return out
}

/* ---------- 收听会话 ---------- */

function startSession() {
  init()
  const open = getOpenSession()
  if (open) return { ...open, reused: true }
  const id = `s_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  db.prepare('INSERT INTO sessions (id, started_at, adjustments) VALUES (?, ?, ?)').run(id, now(), '{}')
  return { ...getSession(id), reused: false }
}

function getSession(id) {
  init()
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
  if (!row) return null
  return { ...row, adjustments: safeParse(row.adjustments) }
}

function getOpenSession() {
  init()
  const row = db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get()
  if (!row) return null
  return { ...row, adjustments: safeParse(row.adjustments) }
}

/** 停止收听：结束会话并清空本次的临时调整（下次开播恢复个人默认）。 */
function endSession(reason = 'stopped') {
  init()
  const open = getOpenSession()
  if (!open) return { ended: false }
  db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ?, adjustments = ? WHERE id = ?').run(
    now(),
    reason,
    '{}',
    open.id,
  )
  return { ended: true, id: open.id, reason, adjustments: open.adjustments }
}

/**
 * 启动时收尾：服务重启后，上一条开着但没有心跳的会话不再视为进行中。
 * 否则网页刷新会“复活”一个早就不在播的会话。
 * 这里不删数据，只补上结束时间与原因，便于回溯。
 */
function closeStaleSessions(reason = 'server_restart') {
  init()
  const open = getOpenSession()
  if (!open) return { closed: 0 }
  db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(now(), reason, open.id)
  return { closed: 1, id: open.id }
}

function setAdjustment(sessionId, key, value) {
  init()
  const s = getSession(sessionId)
  if (!s || s.ended_at) throw new Error('会话不存在或已结束')
  const next = { ...s.adjustments }
  if (value === null || value === undefined || value === '') delete next[key]
  else next[key] = String(value)
  db.prepare('UPDATE sessions SET adjustments = ? WHERE id = ?').run(JSON.stringify(next), sessionId)
  return next
}

function safeParse(s) {
  try {
    return JSON.parse(s) || {}
  } catch (_) {
    return {}
  }
}

/* ---------- 播放记录 ---------- */

function recordPlay({ sessionId = null, trackId, trackName, artists }) {
  init()
  const res = db
    .prepare(
      'INSERT INTO plays (session_id, track_id, track_name, artists, started_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(sessionId, trackId, trackName || null, artists || null, now())
  return Number(res.lastInsertRowid)
}

function finishPlay(playId, outcome) {
  init()
  if (!playId) return
  db.prepare('UPDATE plays SET ended_at = ?, outcome = ? WHERE id = ?').run(now(), outcome, playId)
}

function recentPlays(limit = 50) {
  init()
  return db.prepare('SELECT * FROM plays ORDER BY started_at DESC LIMIT ?').all(limit)
}

/** 最近播放过的曲目 id，供选歌避免短时间重复。 */
function recentlyPlayedIds(withinMs) {
  init()
  const since = now() - withinMs
  return db
    .prepare('SELECT DISTINCT track_id FROM plays WHERE started_at >= ?')
    .all(since)
    .map((r) => Number(r.track_id))
}

module.exports = {
  init,
  DB_FILE,
  listSettings,
  getSetting,
  getNumberSetting,
  setSetting,
  addFeedback,
  revokeFeedback,
  getActiveFeedback,
  listFeedback,
  activeFeedbackMap,
  feedbackSummary,
  startSession,
  getSession,
  getOpenSession,
  endSession,
  closeStaleSessions,
  setAdjustment,
  recordPlay,
  finishPlay,
  recentPlays,
  recentlyPlayedIds,
}
