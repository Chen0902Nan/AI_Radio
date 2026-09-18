/**
 * Codex 选歌适配（迁移自 server/codex.js）：通过本机 `codex exec` 子进程复用现有订阅。
 *
 * 设计要点（依据 docs/adr/0001-local-codex-subprocess.md）：
 *  - 用 `--output-schema` 约束最终响应结构，用 `-o` 单独取最终消息，不解析外层事件流。
 *  - `--sandbox read-only` + 独立空工作目录 + `--ignore-user-config`：不让它读写项目。
 *  - 超时用信号杀掉子进程，不能让调用方无限等待。
 *  - 模型输出一律当不可信输入：id 必须在候选集里、不能重复、必须有理由。
 */
import { Injectable } from '@nestjs/common'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { CODEX } from '../config/app-config'

export interface CodexCandidate {
  id: number
  name: string
  artists: string
  album: string
  durationMs?: number
}

export interface CodexResult {
  ok: boolean
  picks?: Array<CodexCandidate & { reason: string }>
  rejected?: Array<{ id?: unknown; why: string }>
  code?: string
  message?: string
  meta?: Record<string, unknown>
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: boolean
}

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
const stats = { calls: 0, injected: 0, lastMode: 'off', lastAt: null as string | null }

export function setCodexMode(mode: string, { delayMs }: { delayMs?: number } = {}): string {
  injectedMode = mode || 'off'
  if (delayMs !== undefined) injectedDelayMs = Math.max(0, Number(delayMs) || 0)
  stats.lastMode = injectedMode
  return injectedMode
}
export function getCodexMode(): string {
  return injectedMode
}
export function getStats(): Record<string, unknown> {
  return { ...stats, mode: injectedMode, delayMs: injectedDelayMs }
}
export function resetStats(): void {
  stats.calls = 0
  stats.injected = 0
  stats.lastAt = null
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const INJECTED_RAW: Record<string, { picks: Array<{ id?: number | null; reason: string }> }> = {
  // 全是编造的 id：应被校验全部拒绝，最终判为输出无效
  invalid: { picks: [{ id: 111111111, reason: '编造的 id' }, { id: -5, reason: '负数 id' }] },
  // 一半编造、一半真实：真实部分应保留，编造部分应被丢弃并记录
  partial: { picks: [{ id: 111111111, reason: '编造的 id' }, { id: null, reason: '缺 id' }] },
}

/** 仅测试注入用：从候选里取 n 首真实的，模拟「部分合法」的模型输出。 */
function pickRealFor(candidates: CodexCandidate[], n: number) {
  return candidates.slice(0, n).map((c) => ({ id: c.id, reason: '（测试注入）真实候选' }))
}

/** 子进程执行与失败分类（供 DJ 文案模块复用，ADR-0001）。 */
export function execWithTimeout(bin: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String((err as Error).message), timedOut: false, spawnError: true })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout!.on('data', (d: Buffer) => (stdout += d))
    child.stderr!.on('data', (d: Buffer) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err.message), timedOut, spawnError: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

export function parseTokens(stdout: string): number | null {
  const m = stdout.match(/tokens used[^0-9]*([\d,]+)/i)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

export function classifyFailure({ code, stdout, stderr, timedOut }: ExecResult): string {
  if (timedOut) return 'timeout'
  const text = `${stderr}\n${stdout}`.toLowerCase()
  if (/usage limit|rate limit|quota|insufficient|too many requests|429|额度|限流/.test(text)) return 'quota'
  if (/login|unauthorized|401|authentication|not logged in/.test(text)) return 'auth'
  return code === 0 ? 'invalid_output' : 'error'
}

const tail = (s: unknown, n = 400) => String(s || '').trim().slice(-n)

/** 校验模型输出：只保留 id 在候选集里、不重复、且有理由的条目。 */
export function validatePicks(raw: unknown, candidates: CodexCandidate[]): {
  valid: Array<CodexCandidate & { reason: string }>
  rejected: Array<{ id?: unknown; why: string }>
  structurallyInvalid: boolean
} {
  const byId = new Map(candidates.map((c) => [Number(c.id), c]))
  const seen = new Set<number>()
  const valid: Array<CodexCandidate & { reason: string }> = []
  const rejected: Array<{ id?: unknown; why: string }> = []
  const list = raw && Array.isArray((raw as { picks?: unknown }).picks) ? (raw as { picks: unknown[] }).picks : null
  if (!list) return { valid, rejected, structurallyInvalid: true }
  for (const item of list) {
    const rec = item as Record<string, unknown> | null
    const id = Number(rec && rec.id)
    const reason = typeof (rec && rec.reason) === 'string' ? ((rec as Record<string, unknown>).reason as string).trim() : ''
    if (!Number.isFinite(id)) {
      rejected.push({ id: rec && rec.id, why: 'id 不是数字' })
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
    valid.push({ ...byId.get(id)!, reason })
  }
  return { valid, rejected, structurallyInvalid: false }
}

export function buildPrompt({ candidates, brief, count }: { candidates: CodexCandidate[]; brief: string; count: number }): string {
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

@Injectable()
export class CodexService {
  /**
   * 让 Codex 从候选里选歌。任何失败都不抛出：调用方只需要决定是否沿用原队列。
   */
  async pickTracks(opts: {
    candidates?: CodexCandidate[]
    brief?: string
    count?: number
    timeoutMs?: number
  } = {}): Promise<CodexResult> {
    const { brief, count = 5, timeoutMs = CODEX.timeoutMs } = opts
    const candidates = opts.candidates
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { ok: false, code: 'no_candidates', message: '没有可用的候选歌曲', meta: {} }
    }
    const wanted = Math.max(1, Math.min(Number(count) || 5, candidates.length))
    const started = Date.now()
    stats.calls += 1
    stats.lastAt = new Date(started).toISOString()
    if (process.env.RADIO_TEST_HOOKS === '1' && injectedMode !== 'off') stats.injected += 1

    let raw: { picks: unknown[] } | null = null
    let meta: Record<string, unknown> = { candidates: candidates.length, requested: wanted, timeoutMs, mode: injectedMode }

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
      let result: ExecResult
      try {
        const schemaFile = path.join(dir, 'schema.json')
        const outFile = path.join(dir, 'out.json')
        const workDir = path.join(dir, 'work')
        fs.mkdirSync(workDir)
        fs.writeFileSync(schemaFile, JSON.stringify(PICK_SCHEMA), 'utf-8')

        result = await execWithTimeout(
          CODEX.bin,
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
          return { ok: false, code: 'invalid_output', message: 'Codex 输出不是合法 JSON：' + (err as Error).message, meta }
        }
      } finally {
        // 进程自建的空工作目录（schema 副本与空 work 目录），不含用户数据，直接删除
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
    return { ok: true, picks: valid.slice(0, wanted), rejected, meta: { ...meta, durationMs: (meta.durationMs as number) ?? Date.now() - started } }
  }
}
