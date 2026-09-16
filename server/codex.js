/**
 * Codex 选歌适配层：通过本机 `codex exec` 子进程复用现有 ChatGPT/Codex 订阅。
 *
 * 设计要点（依据 docs/adr/0001-local-codex-subprocess.md 与接入核验）：
 *  - 用 `--output-schema` 约束最终响应结构，用 `-o` 单独取最终消息，不解析外层事件流。
 *  - `--sandbox read-only` + 独立空工作目录 + `--ignore-user-config`：不让它读写项目、
 *    也不加载用户的 skills 上下文，减少无关 token。
 *  - 超时用信号杀掉子进程，不能让调用方无限等待。
 *  - 模型输出一律当不可信输入：id 必须在候选集里、不能重复、必须有理由，
 *    不通过的部分丢弃并记录原因；一条都不合法才算输出无效。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const CODEX_BIN = process.env.CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex'
const DEFAULT_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 90000)

const PICK_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
}

/* ---------- 测试注入（仅 RADIO_TEST_HOOKS=1） ---------- */

let injectedMode = 'off'
let injectedDelayMs = 0
// 调用计数：用于验证「同一会话不会并发生成多批」和「冷却期不消耗订阅」。
const stats = { calls: 0, injected: 0, lastMode: 'off', lastAt: null }

function setCodexMode(mode, { delayMs } = {}) {
  injectedMode = mode || 'off'
  if (delayMs !== undefined) injectedDelayMs = Math.max(0, Number(delayMs) || 0)
  stats.lastMode = injectedMode
  return injectedMode
}
function getCodexMode() {
  return injectedMode
}
function getStats() {
  return { ...stats, mode: injectedMode, delayMs: injectedDelayMs }
}
function resetStats() {
  stats.calls = 0
  stats.injected = 0
  stats.lastAt = null
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const INJECTED_RAW = {
  // 全是编造的 id：应被校验全部拒绝，最终判为输出无效
  invalid: { picks: [{ id: 111111111, reason: '编造的 id' }, { id: -5, reason: '负数 id' }] },
  // 一半编造、一半真实：真实部分应保留，编造部分应被丢弃并记录
  partial: { picks: [{ id: 111111111, reason: '编造的 id' }, { id: null, reason: '缺 id' }] },
}

/* ---------- 提示词 ---------- */

function buildPrompt({ candidates, brief, count }) {
  const list = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    artists: c.artists,
    album: c.album,
    minutes: c.durationMs ? Math.round(c.durationMs / 60000) : undefined,
  }))
  return [
    '你是个人电台的选歌助手。下面是一份候选歌曲列表（JSON）。',
    `请从中挑 ${count} 首，按播放顺序排列，用于这样的收听场景：${brief}`,
    '',
    '约束：',
    `- 只能使用候选列表里出现过的 id，绝对不要编造或推测 id。`,
    `- 每首选一句中文理由，不超过 40 字，说明为什么适合这个场景。`,
    '- 不要重复选同一首。',
    '- 只输出结构化结果，不要输出解释过程或额外文字。',
    '',
    '候选列表：',
    JSON.stringify(list),
  ].join('\n')
}

/* ---------- 调用 ---------- */

function execWithTimeout(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err.message), timedOut: false, spawnError: true })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err.message), timedOut, spawnError: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

function parseTokens(stdout) {
  const m = stdout.match(/tokens used[^0-9]*([\d,]+)/i)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

function classifyFailure({ code, stdout, stderr, timedOut }) {
  if (timedOut) return 'timeout'
  const text = `${stderr}\n${stdout}`.toLowerCase()
  if (/usage limit|rate limit|quota|insufficient|too many requests|429|额度|限流/.test(text)) return 'quota'
  if (/login|unauthorized|401|authentication|not logged in/.test(text)) return 'auth'
  return code === 0 ? 'invalid_output' : 'error'
}

const tail = (s, n = 400) => String(s || '').trim().slice(-n)

/** 校验模型输出：只保留 id 在候选集里、不重复、且有理由的条目。 */
function validatePicks(raw, candidates) {
  const byId = new Map(candidates.map((c) => [Number(c.id), c]))
  const seen = new Set()
  const valid = []
  const rejected = []
  const list = raw && Array.isArray(raw.picks) ? raw.picks : null
  if (!list) return { valid, rejected, structurallyInvalid: true }
  for (const item of list) {
    const id = Number(item && item.id)
    const reason = typeof (item && item.reason) === 'string' ? item.reason.trim() : ''
    if (!Number.isFinite(id)) {
      rejected.push({ id: item && item.id, why: 'id 不是数字' })
      continue
    }
    if (!byId.has(id)) {
      rejected.push({ id, why: '不在候选集里（模型编造的 id）' })
      continue
    }
    if (seen.has(id)) {
      rejected.push({ id, why: '重复出现' })
      continue
    }
    if (!reason) {
      rejected.push({ id, why: '缺少选歌理由' })
      continue
    }
    seen.add(id)
    valid.push({ ...byId.get(id), reason })
  }
  return { valid, rejected, structurallyInvalid: false }
}

/**
 * 让 Codex 从候选里选歌。
 * 返回 { ok:true, picks, rejected, meta } 或 { ok:false, code, message, meta }。
 * 任何失败都不会抛出：调用方只需要决定是否沿用原队列。
 */
async function pickTracks({ candidates, brief, count = 5, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, code: 'no_candidates', message: '没有可用的候选歌曲', meta: {} }
  }
  const wanted = Math.max(1, Math.min(Number(count) || 5, candidates.length))
  const started = Date.now()
  stats.calls += 1
  stats.lastAt = new Date(started).toISOString()
  if (process.env.RADIO_TEST_HOOKS === '1' && injectedMode !== 'off') stats.injected += 1

  let raw = null
  let meta = { candidates: candidates.length, requested: wanted, timeoutMs, mode: injectedMode }

  if (process.env.RADIO_TEST_HOOKS === '1' && injectedMode !== 'off') {
    if (injectedMode === 'slow') {
      // 慢响应：用于验证「补歌不阻塞已有音乐」以及暂停/停止时的迟到结果
      await sleep(injectedDelayMs || 4000)
      raw = { picks: pickRealFor(candidates, wanted) }
    }
    if (injectedMode === 'success') {
      raw = { picks: pickRealFor(candidates, wanted) }
    }
    if (injectedMode === 'timeout') {
      return {
        ok: false,
        code: 'timeout',
        message: `（测试注入）Codex 超过 ${timeoutMs}ms 未返回`,
        meta: { ...meta, durationMs: Date.now() - started, injected: true },
      }
    }
    if (injectedMode === 'quota') {
      return {
        ok: false,
        code: 'quota',
        message: '（测试注入）Codex 订阅额度/速率受限',
        meta: { ...meta, durationMs: Date.now() - started, injected: true },
      }
    }
    if (injectedMode === 'invalid') raw = INJECTED_RAW.invalid
    if (injectedMode === 'partial') raw = { picks: [...INJECTED_RAW.partial.picks, ...pickRealFor(candidates, 2)] }
  }

  if (!raw) {
    const prompt = buildPrompt({ candidates, brief: brief || '随意，适合现在听', count: wanted })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-codex-'))
    let result
    try {
      const schemaFile = path.join(dir, 'schema.json')
      const outFile = path.join(dir, 'out.json')
      const workDir = path.join(dir, 'work')
      fs.mkdirSync(workDir)
      fs.writeFileSync(schemaFile, JSON.stringify(PICK_SCHEMA), 'utf-8')

      result = await execWithTimeout(
        CODEX_BIN,
        [
          'exec',
          '-C', workDir,
          '--skip-git-repo-check',
          '--sandbox', 'read-only',
          '--ephemeral',
          '--ignore-user-config',
          '--color', 'never',
          '--output-schema', schemaFile,
          '-o', outFile,
          prompt,
        ],
        timeoutMs,
      )

      meta = {
        ...meta,
        durationMs: Date.now() - started,
        exitCode: result.code,
        timedOut: result.timedOut,
        tokens: parseTokens(`${result.stdout}\n${result.stderr}`),
        spawnError: Boolean(result.spawnError),
      }

      if (result.timedOut) {
        return { ok: false, code: 'timeout', message: `Codex 超过 ${timeoutMs}ms 未返回，已终止`, meta }
      }
      if (result.code !== 0) {
        return {
          ok: false,
          code: classifyFailure(result),
          message: `Codex 退出码 ${result.code}：${tail(result.stderr || result.stdout)}`,
          meta,
        }
      }
      if (!fs.existsSync(outFile)) {
        return { ok: false, code: 'invalid_output', message: 'Codex 没有写出最终消息', meta }
      }
      try {
        raw = JSON.parse(fs.readFileSync(outFile, 'utf-8'))
      } catch (err) {
        return { ok: false, code: 'invalid_output', message: 'Codex 输出不是合法 JSON：' + err.message, meta }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  const { valid, rejected, structurallyInvalid } = validatePicks(raw, candidates)
  if (structurallyInvalid || valid.length === 0) {
    return {
      ok: false,
      code: 'invalid_output',
      message: structurallyInvalid
        ? 'Codex 输出结构不符合 schema'
        : `Codex 输出的 ${rejected.length} 条全部不合法（id 不在候选集里 / 重复 / 缺理由）`,
      rejected,
      meta,
    }
  }
  return { ok: true, picks: valid.slice(0, wanted), rejected, meta: { ...meta, durationMs: meta.durationMs ?? Date.now() - started } }
}

/** 仅测试注入用：从候选里取 n 首真实的，模拟“部分合法”的模型输出。 */
function pickRealFor(candidates, n) {
  return candidates.slice(0, n).map((c) => ({ id: c.id, reason: '（测试注入）真实候选' }))
}

module.exports = {
  pickTracks,
  validatePicks,
  buildPrompt,
  setCodexMode,
  getCodexMode,
  getStats,
  resetStats,
  // 供 DJ 文案模块复用同一套子进程执行与失败分类（任务 02）
  execWithTimeout,
  classifyFailure,
  CODEX_BIN,
  DEFAULT_TIMEOUT_MS,
}
