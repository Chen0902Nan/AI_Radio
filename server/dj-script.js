/**
 * DJ 文案模块（任务 02）：针对紧邻下一首歌，搜索有出处的资料并生成结构化串场稿。
 *
 * 设计要点（依据 .scratch/dj-segue/contract.md 第 3 节与任务 02 工单）：
 *  - 复用 server/codex.js 的本机订阅子进程执行与失败分类；一次 DJ 请求内完成搜索与写稿，
 *    不发起多个无界模型调用，也不做自动修稿循环（结构不过即失败，下个机会再试）。
 *  - 搜索通过 `-c web_search="live"` 显式开启（CLI 0.153.4 参数解析已核验）；
 *    `--json` 的事件流只用于提取「搜索活动摘要」，不假定事件结构固定、
 *    也不假定事件包含来源正文——真实事件字段由任务 07 用实际样例核实。
 *  - 模型输出一律当不可信输入：先过 JSON schema，再过 public/program-contract.js 的
 *    结构校验（非空稿、长度、目标身份、来源引用、未证实说法的播出归因）。
 *    结构校验不能证明来源支持内容；真实归因核对由 07/08 用真实样例完成。
 *  - 查无资料时返回 basic_only（只介绍已知歌名/歌手与氛围）；整个请求失败返回明确失败码，
 *    不抛出，不阻塞音乐。选歌（pickTracks）与本模块完全分离。
 *
 * 验证边界：本模块不能程序性证明「来源内容属实」。documented 也只是「所读资料支持该陈述」。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const contract = require('../public/program-contract')
const codex = require('./codex')

const DEFAULT_TIMEOUT_MS = Number(process.env.DJ_SCRIPT_TIMEOUT_MS || 90000)
const TODAY = () => new Date().toISOString().slice(0, 10)

/* ---------- 测试注入（仅 RADIO_TEST_HOOKS=1；供 05/08 服务端联调） ---------- */

let injectedMode = 'off'
let injectedDelayMs = 0
const stats = { calls: 0, injected: 0, lastMode: 'off', lastAt: null }

function setDjScriptMode(mode, { delayMs } = {}) {
  injectedMode = mode || 'off'
  if (delayMs !== undefined) injectedDelayMs = Math.max(0, Number(delayMs) || 0)
  stats.lastMode = injectedMode
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

/* ---------- 输出 schema ---------- */

const DJ_SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    storyStatus: { type: 'string', enum: ['sourced', 'basic_only'] },
    scriptText: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['documented', 'unverified_account'] },
          sourceIds: { type: 'array', items: { type: 'string' } },
          spokenAttribution: { type: 'string' },
        },
        required: ['id', 'text', 'kind', 'sourceIds', 'spokenAttribution'],
        additionalProperties: false,
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          publisherOrAuthor: { type: 'string' },
          evidence: { type: 'string' },
          retrievedAt: { type: 'string' },
        },
        required: ['id', 'url', 'title', 'publisherOrAuthor', 'evidence', 'retrievedAt'],
        additionalProperties: false,
      },
    },
  },
  required: ['storyStatus', 'scriptText', 'claims', 'sources'],
  additionalProperties: false,
}

/* ---------- 提示词 ---------- */

function buildSeguePrompt({ targetName, targetArtists, album, brief, today }) {
  return [
    '你是个人电台的 DJ 资料撰稿人。请先联网搜索，再为接下来要播放的歌曲写一段中文串场稿。',
    '',
    `目标歌曲：${targetName} — ${targetArtists}${album ? `（专辑：${album}）` : ''}`,
    `收听氛围：${brief || '随意，适合当下'}`,
    `今天日期：${today}（来源 retrievedAt 一律用这个日期）`,
    '',
    '工作方式：',
    '1. 先用网络搜索这首歌的创作背景、歌手相关经历、专辑介绍或乐迷讨论；打开并阅读来源页面，再决定讲什么。',
    '2. 每段稿只挑一个最有出处的亮点讲，不要罗列百科式信息。',
    '3. 每条陈述（claim）必须标注它引用的来源 id；来源（sources）逐条给出实际访问到的页面。',
    '',
    '硬性要求：',
    '- 串场稿 50 到 140 个汉字（目标 15–30 秒），直接可以朗读，不要出现 URL 或「根据网络资料」这类空泛表述。',
    '- 论坛帖子、个人文章、乐迷分享都可以作为来源；未证实的传闻/民间说法必须用 claim kind = unverified_account，',
    '  并且在串场稿正文里自然说明出处和它是一种说法，例如「有乐迷在某论坛分享过一种理解……」。',
    '  claim 的 spokenAttribution 字段必须填写串场稿里那句归因的原文（与正文逐字一致）；元数据标记不能代替正文归因。',
    '- 不同来源说法不一致时，只讲其中一个版本并说明出处，或说明存在不同说法；不要拼成一个确定的故事。',
    '- evidence 只写支持该陈述的短摘录或摘要（不超过 200 字），不要把整篇文章抄进来。',
    '- 搜索失败、来源打不开或找不到能核对出处的内容时：storyStatus = basic_only，',
    '  只介绍已知歌名/歌手并衔接氛围，claims 和 sources 留空；绝不编造出处或把猜测写成事实。',
    '- 只输出结构化结果，不要输出解释过程。',
  ].join('\n')
}

/* ---------- 搜索活动摘要 ---------- */

function collectUrls(value, out, depth = 0) {
  if (depth > 6 || value == null) return
  if (typeof value === 'string') {
    for (const m of value.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
      if (out.size >= 50) return
      out.add(m[0].replace(/[.,;)\]]+$/, ''))
    }
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectUrls(v, out, depth + 1)
  }
}

/**
 * 从 `--json` 事件流提取搜索活动摘要。不假定事件结构：凡 type/消息类型里含 search
 * 的计为搜索事件，并从事件里出现的字符串收集 URL 样本。真实事件字段由 07 核实。
 */
function summarizeSearchActivity(stdout) {
  const urls = new Set()
  let searchEvents = 0
  const querySample = []
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let obj
    try {
      obj = JSON.parse(t)
    } catch (_) {
      continue
    }
    const type = [obj.type, obj.msg && obj.msg.type, obj.item && obj.item.type, obj.action && obj.action.type]
      .filter(Boolean)
      .join(' ')
    if (/search/i.test(type)) {
      searchEvents += 1
      const q =
        obj.query ||
        (obj.msg && obj.msg.query) ||
        (obj.item && obj.item.query) ||
        ((obj.item && obj.item.action && obj.item.action.query) || (obj.action && obj.action.query))
      if (typeof q === 'string' && querySample.length < 5) querySample.push(q.slice(0, 100))
    }
    collectUrls(obj, urls)
  }
  return { searchEvents, urls: [...urls], querySample }
}

/* ---------- 执行 ---------- */

const tail = (s, n = 400) => String(s || '').trim().slice(-n)

async function execFinalReal({ prompt, timeoutMs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-dj-'))
  try {
    const schemaFile = path.join(dir, 'schema.json')
    const outFile = path.join(dir, 'out.json')
    const workDir = path.join(dir, 'work')
    fs.mkdirSync(workDir)
    fs.writeFileSync(schemaFile, JSON.stringify(DJ_SCRIPT_SCHEMA), 'utf-8')

    const result = await codex.execWithTimeout(
      codex.CODEX_BIN,
      [
        'exec',
        '-C', workDir,
        '--skip-git-repo-check',
        '--sandbox', 'read-only',
        '--ephemeral',
        '--ignore-user-config',
        '--color', 'never',
        '-c', 'web_search="live"',
        '--output-schema', schemaFile,
        '--json',
        '-o', outFile,
        prompt,
      ],
      timeoutMs,
    )

    let finalJson = null
    if (!result.timedOut && result.code === 0 && fs.existsSync(outFile)) {
      try {
        finalJson = JSON.parse(fs.readFileSync(outFile, 'utf-8'))
      } catch (_) {
        finalJson = null
      }
    }
    return { ...result, finalJson }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/* 注入模式用的成品模板（与契约样例同构，不含真实凭据）。 */
const INJECTED_FINAL = {
  success: () => {
    const s = contract.SAMPLES.sourcedScript()
    return { storyStatus: s.storyStatus, scriptText: s.scriptText, claims: s.claims, sources: s.sources }
  },
  basic_only: () => {
    const s = contract.SAMPLES.basicOnlyScript()
    return { storyStatus: s.storyStatus, scriptText: s.scriptText, claims: s.claims, sources: s.sources }
  },
  invalid: () => {
    const s = contract.SAMPLES.sourcedScript()
    s.claims[0].sourceIds = ['s999']
    return { storyStatus: s.storyStatus, scriptText: s.scriptText, claims: s.claims, sources: s.sources }
  },
  missing_attribution: () => {
    const s = contract.SAMPLES.sourcedScript()
    s.claims[0].spokenAttribution = ''
    return { storyStatus: s.storyStatus, scriptText: s.scriptText, claims: s.claims, sources: s.sources }
  },
  empty: () => {
    const s = contract.SAMPLES.sourcedScript()
    return { storyStatus: s.storyStatus, scriptText: '   ', claims: [], sources: [] }
  },
}
const INJECTED_FAILURE = {
  timeout: () => ({ ok: false, code: 'timeout', message: '（测试注入）Codex 超时' }),
  quota: () => ({ ok: false, code: 'quota', message: '（测试注入）Codex 额度受限' }),
}

/**
 * 生成串场稿。返回
 *  - { ok:true, script, meta } 其中 script 已附带 targetTrackId/targetItemId/transitionId
 *    并通过 program-contract 校验；meta.searchActivity 是搜索活动摘要。
 *  - { ok:false, code, message, meta?, errors? }
 * 任何失败都不抛出：调用方（05）据此把机会标记为 unavailable，音乐不受影响。
 */
async function generateSegueScript(input, deps = {}) {
  const execFinal = deps.execFinal || execFinalReal
  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS

  // 输入守卫：身份/目标不完整直接拒绝，不发起模型调用。
  const tid = toInt(input && input.targetTrackId)
  const problems = []
  if (tid === null) problems.push('targetTrackId 必须是数字')
  if (typeof (input && input.targetName) !== 'string' || !input.targetName.trim()) problems.push('缺少目标歌名 targetName')
  if (typeof (input && input.targetItemId) !== 'string' || !input.targetItemId.trim()) problems.push('缺少目标条目 targetItemId')
  if (typeof (input && input.transitionId) !== 'string' || !input.transitionId.trim()) problems.push('缺少机会身份 transitionId')
  if (input && input.brief !== undefined && typeof input.brief !== 'string') problems.push('brief 必须是字符串')
  else if (input && typeof input.brief === 'string' && input.brief.length > contract.MAX_CONTEXT_CHARS) problems.push('brief 超长')
  if (problems.length) {
    return { ok: false, code: 'invalid_input', message: problems.join('；'), meta: {} }
  }

  const started = Date.now()
  stats.calls += 1
  stats.lastAt = new Date(started).toISOString()

  // 服务端测试注入：不调用真实模型。
  if (process.env.RADIO_TEST_HOOKS === '1' && injectedMode !== 'off') {
    stats.injected += 1
    if (injectedDelayMs) await sleep(injectedDelayMs)
    if (INJECTED_FAILURE[injectedMode]) {
      return { ...INJECTED_FAILURE[injectedMode](), meta: { durationMs: Date.now() - started, injected: true } }
    }
    const finalJson = INJECTED_FINAL[injectedMode] ? INJECTED_FINAL[injectedMode]() : null
    return finish({ code: 0, stdout: '', stderr: '', timedOut: false, finalJson }, {
      input, started, timeoutMs, injected: true,
    })
  }

  const prompt = buildSeguePrompt({
    targetName: input.targetName.trim(),
    targetArtists: String(input.targetArtists || '').trim(),
    album: input.album ? String(input.album).trim() : '',
    brief: input.brief || '',
    today: TODAY(),
  })
  const result = await execFinal({ prompt, timeoutMs })
  return finish(result, { input, started, timeoutMs, injected: false })
}

function finish(result, { input, started, timeoutMs, injected }) {
  const meta = {
    durationMs: Date.now() - started,
    timeoutMs,
    injected,
    exitCode: result.code,
    timedOut: Boolean(result.timedOut),
    searchActivity: summarizeSearchActivity(result.stdout),
  }
  if (result.timedOut) {
    return { ok: false, code: 'timeout', message: `Codex 超过 ${timeoutMs}ms 未返回，已终止`, meta }
  }
  if (result.code !== 0) {
    return {
      ok: false,
      code: codex.classifyFailure(result),
      message: `Codex 退出码 ${result.code}：${tail(result.stderr || result.stdout)}`,
      meta,
    }
  }
  if (!result.finalJson || typeof result.finalJson !== 'object') {
    return { ok: false, code: 'invalid_output', message: 'Codex 没有写出合法的最终结构化结果', meta }
  }

  // 身份由本模块附加（模型不负责机会身份），随后按契约做结构校验。
  const script = {
    targetTrackId: Number(input.targetTrackId),
    targetItemId: input.targetItemId,
    transitionId: input.transitionId,
    targetName: String(input.targetName || '').trim(),
    targetArtists: String(input.targetArtists || '').trim(),
    storyStatus: result.finalJson.storyStatus,
    scriptText: result.finalJson.scriptText,
    claims: Array.isArray(result.finalJson.claims) ? result.finalJson.claims : [],
    sources: Array.isArray(result.finalJson.sources) ? result.finalJson.sources : [],
  }
  const v = contract.validateScript(script, {
    targetTrackId: script.targetTrackId,
    targetItemId: script.targetItemId,
    transitionId: script.transitionId,
  })
  if (!v.ok) {
    return {
      ok: false,
      code: 'invalid_output',
      message: `Codex 文案未通过结构校验（${v.errors.map((e) => e.code).join(', ')}）`,
      errors: v.errors,
      meta,
    }
  }
  return { ok: true, script: v.value, meta }
}

function toInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

module.exports = {
  DJ_SCRIPT_SCHEMA,
  buildSeguePrompt,
  summarizeSearchActivity,
  generateSegueScript,
  setDjScriptMode,
  getStats,
  resetStats,
  DEFAULT_TIMEOUT_MS,
}
