import { spawn } from 'node:child_process'
import type { ExecResult } from './codex-types'

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
