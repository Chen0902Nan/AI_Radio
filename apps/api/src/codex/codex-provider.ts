import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CODEX } from '../config/app-config'
import { defaultMoveToTrash } from '../dj/audio-cache'
import { execWithTimeout, classifyFailure, parseTokens } from './codex-process'
import type { ExecResult, PickResponse, CodexResult } from './codex-types'

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


function executionFailure(result: ExecResult, outFile: string, timeoutMs: number, meta: Record<string, unknown>): CodexResult | null {
  if (result.timedOut) return { ok: false, code: 'timeout', message: `Codex 超过 ${timeoutMs}ms 未返回，已终止`, meta }
  if (result.code !== 0) return { ok: false, code: classifyFailure(result), message: `Codex 退出码 ${result.code}：${(result.stderr || result.stdout).trim().slice(-400)}`, meta }
  if (!fs.existsSync(outFile)) return { ok: false, code: 'invalid_output', message: 'Codex 没有写出最终消息', meta }
  return null
}
function readOutput(outFile: string, meta: Record<string, unknown>): PickResponse {
  try { return { raw: JSON.parse(fs.readFileSync(outFile, 'utf-8')) as unknown, meta } }
  catch (error) { return { failure: { ok: false, code: 'invalid_output', message: 'Codex 输出不是合法 JSON：' + (error instanceof Error ? error.message : String(error)), meta } } }
}
export async function requestPicks(prompt: string, timeoutMs: number, started: number, initialMeta: Record<string, unknown>): Promise<PickResponse> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-codex-'))
  try {
    const schemaFile = path.join(dir, 'schema.json')
    const outFile = path.join(dir, 'out.json')
    const workDir = path.join(dir, 'work')
    fs.mkdirSync(workDir)
    fs.writeFileSync(schemaFile, JSON.stringify(PICK_SCHEMA), 'utf-8')
    const result = await execWithTimeout(CODEX.bin, [
      'exec', '-C', workDir, '--skip-git-repo-check', '--sandbox', 'read-only',
      '--ephemeral', '--ignore-user-config', '--color', 'never',
      '--output-schema', schemaFile, '-o', outFile, prompt,
    ], timeoutMs)
    const meta = {
      ...initialMeta, durationMs: Date.now() - started, exitCode: result.code,
      timedOut: result.timedOut, tokens: parseTokens(`${result.stdout}\n${result.stderr}`), spawnError: Boolean(result.spawnError),
    }
    const failure = executionFailure(result, outFile, timeoutMs, meta)
    return failure ? { failure } : readOutput(outFile, meta)
  } finally {
    const cleanup = defaultMoveToTrash(dir, path.dirname(dir))
    if (!cleanup.ok) throw new Error('无法将 Codex 临时目录移入废纸篓')
  }
}
