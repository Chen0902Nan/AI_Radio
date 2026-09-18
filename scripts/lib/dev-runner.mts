import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

interface Command { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
interface DevOptions { cwd: string; build: Command[]; watchPaths: string[]; backend: Command; frontend?: Command | null }
interface Running { child: ChildProcess; stopping: boolean; done: Promise<number> }

// 只有编译成功才替换运行中的后端；Vite 自己处理前端 HMR。
export async function runDev({ cwd, build, watchPaths, backend, frontend }: DevOptions): Promise<number> {
  const children = new Set<Running>()
  let closing = false, building = false, dirty = false, timer: NodeJS.Timeout | undefined, monitor: NodeJS.Timeout | undefined, api: Running | undefined
  let complete!: (arg0: number) => void
  const finished = new Promise<number>(resolve => { complete = resolve })

  function launch(command: Command, service = false) {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd || cwd, env: { ...process.env, ...command.env },
      stdio: 'inherit', detached: process.platform !== 'win32',
    })
    const entry: Running = { child, stopping: false, done: Promise.resolve(0) }
    children.add(entry)
    entry.done = new Promise<number>(resolve => {
      const finish = (code: number) => {
        children.delete(entry)
        resolve(code)
        if (service && !closing && !entry.stopping) {
          console.error('[dev] 服务意外退出，停止开发环境。')
          void shutdown(code || 1)
        }
      }
      child.once('error', error => { console.error('[dev]', (error instanceof Error ? error.message : String(error))); finish(1) })
      child.once('exit', code => finish(code ?? 1))
    })
    return entry
  }

  async function stop(entry: Running | undefined) {
    if (!entry || !children.has(entry)) return
    const running = entry
    entry.stopping = true
    function signal(name: NodeJS.Signals) {
      try {
        if (process.platform === 'win32') running.child.kill(name)
        else process.kill(-running.child.pid!, name)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    signal('SIGTERM')
    const force = setTimeout(() => signal('SIGKILL'), 2000)
    await entry.done
    clearTimeout(force)
  }

  async function shutdown(code = 0) {
    if (closing) return
    closing = true
    clearTimeout(timer)
    clearInterval(monitor)
    await Promise.all([...children].map(stop))
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    complete(code)
  }
  const interrupt = () => { void shutdown(0) }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)

  async function compile() {
    for (const command of build) {
      if (closing) return false
      if (await launch(command).done !== 0) return false
    }
    return !closing
  }
  async function rebuild() {
    if (building || closing) return
    building = true
    while (dirty && !closing) {
      dirty = false
      console.log('[dev] 源码变更，正在编译…')
      if (await compile()) {
        // 编译期间又有修改时先编译最新版本，避免启动中间产物。
        if (dirty) continue
        await stop(api)
        if (!closing) api = launch(backend, true)
      } else if (!closing) console.error('[dev] 编译失败，保留上一次服务；修正后自动重试。')
    }
    building = false
  }

  try {
    // 小范围轮询源码树，同时支持新增/删除/编辑器原子替换；不依赖系统 watcher 配额。
    function snapshot() {
      const result: Array<[string, number, number, number]> = []
      function visit(file: string) {
        if (!fs.existsSync(file)) return
        const stat = fs.statSync(file)
        if (stat.isDirectory()) {
          for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name))
        } else result.push([file, stat.mtimeMs, stat.ctimeMs, stat.size])
      }
      for (const target of watchPaths) visit(path.resolve(cwd, target))
      return JSON.stringify(result)
    }
    let previous = snapshot()
    monitor = setInterval(() => {
      try {
        const next = snapshot()
        if (next === previous) return
        previous = next
        dirty = true
        clearTimeout(timer)
        timer = setTimeout(() => { void rebuild().catch(error => {
          console.error('[dev]', (error instanceof Error ? error.message : String(error))); void shutdown(1)
        }) }, 150)
      } catch (error) { console.error('[dev]', (error instanceof Error ? error.message : String(error))); void shutdown(1) }
    }, 300)
    building = true
    console.log('[dev] 准备共享包和后端…')
    let ok
    do { dirty = false; ok = await compile() } while (ok && dirty)
    building = false
    if (!ok) await shutdown(1)
    else if (!closing) {
      api = launch(backend, true)
      if (frontend) launch(frontend, true)
      console.log('[dev] 前后端已启动；前端 HMR，后端编译后自动重启。Ctrl+C 一起停止。')
    }
  } catch (error) {
    console.error('[dev]', (error instanceof Error ? error.message : String(error)))
    await shutdown(1)
  }
  return finished
}
