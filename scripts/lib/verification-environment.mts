import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import puppeteer, { type Browser } from 'puppeteer-core'
import { moveToTrash } from './trash.mts'

const project = path.resolve(import.meta.dirname, '../..')
export interface VerificationPaths { root: string; db: string; session: string; cache: string; report: string }
export interface VerificationEnvironment {
  base: string
  fixture: boolean
  paths: VerificationPaths
  browser(): Promise<Browser>
  restart(): Promise<void>
  request(route: string, body?: unknown): Promise<Record<string, unknown> & { status: number }>
  writeReport(report: unknown, destination?: string): string
}
function pathsFor(name: string): VerificationPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `radio-${name}-`))
  return { root, db: path.join(root, 'radio.db'), session: path.join(root, 'session.json'), cache: path.join(root, 'dj-audio'), report: path.join(root, 'report.json') }
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await exited } finally { clearTimeout(deadline) }
}
async function ready(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('隔离服务启动超时')), 30000)
    const finish = (error?: Error, base?: string) => {
      clearTimeout(timer); child.off('message', message); child.off('error', failure); child.off('exit', exited)
      if (error) reject(error)
      else resolve(base!)
    }
    const message = (value: unknown) => {
      if (typeof value === 'object' && value && 'base' in value && typeof value.base === 'string') finish(undefined, value.base)
    }
    const failure = (error: Error) => finish(error)
    const exited = (code: number | null) => finish(new Error(`隔离服务启动失败 (${code})`))
    child.on('message', message); child.once('error', failure); child.once('exit', exited)
  })
}
function closePipes(child: ChildProcess | null | undefined): void {
  // Chrome reporter/updater may inherit stderr after the browser itself has exited.
  child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy()
}
async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return
  const child = browser.process()
  try { await browser.close() } finally { closePipes(child) }
}
async function closeServer(child: ChildProcess | undefined): Promise<void> {
  if (!child) return
  try { await stop(child) } finally { closePipes(child) }
}
async function cleanup(browser: Browser | undefined, child: ChildProcess | undefined, root: string): Promise<void> {
  const errors: unknown[] = []
  for (const action of [() => closeBrowser(browser), () => closeServer(child), () => { moveToTrash(root) }]) {
    try { await action() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, '验证环境清理失败')
}
export async function withVerification<T>(name: string, args: string[], run: (env: VerificationEnvironment) => Promise<T>): Promise<T> {
  if (args.some(a => a.startsWith('--base='))) throw new Error('外部服务模式无法完整恢复原状态，拒绝修改；请使用工具自建的隔离服务')
  const fixture = !args.includes('--real')
  const sessionFile = args.find(a => a.startsWith('--session-file='))?.slice(15)
  if (!fixture && !sessionFile) throw new Error('真实供应商验证需要显式 --real --session-file=<已授权登录态>')
  const paths = pathsFor(name)
  let child: ChildProcess | undefined, browser: Browser | undefined
  try {
    if (sessionFile) fs.copyFileSync(path.resolve(sessionFile), paths.session)
    const env = { ...process.env, RADIO_VERIFY_FIXTURE: fixture ? '1' : '0', RADIO_TEST_HOOKS: '1', RADIO_DATA_DIR: paths.root, RADIO_DB_FILE: paths.db, RADIO_SESSION_FILE: paths.session, DJ_AUDIO_CACHE_DIR: paths.cache }
    const boot = async (restart = false) => {
      child = fork(path.join(project, 'scripts/lib/verification-fixture.cts'), [], { cwd: project, env: { ...env, RADIO_VERIFY_RESTART: restart ? '1' : '0' }, silent: true, execArgv: ['--env-file-if-exists=.env'] })
      const log = fs.createWriteStream(path.join(paths.root, 'server.log'), { flags: 'a' })
      child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false })
      child.once('exit', () => log.end())
      return ready(child)
    }
    let base = await boot()
    const context: VerificationEnvironment = {
      get base() { return base }, fixture, paths,
      async restart() { if (child) await stop(child); base = await boot(true) },
      async browser() {
        browser ??= await puppeteer.launch({ executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: !args.includes('--headful'), userDataDir: path.join(paths.root, 'chrome'), args: ['--mute-audio', '--autoplay-policy=document-user-activation-required'] })
        return browser
      },
      async request(route, body) {
        const res = await fetch(base + route, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        const data: unknown = await res.json()
        if (typeof data !== 'object' || !data || Array.isArray(data)) throw new Error(`无效 HTTP 响应: ${route}`)
        return { ...data, status: res.status }
      },
      writeReport(report, destination) {
        fs.writeFileSync(paths.report, JSON.stringify(report, null, 2) + '\n')
        const output = destination || path.join(process.env.RADIO_REPORT_OUT || path.join(project, '.scratch/verification'), `${name}.json`)
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(paths.report, output)
        return output
      },
    }
    return await run(context)
  } finally {
    await cleanup(browser, child, paths.root)
  }
}
