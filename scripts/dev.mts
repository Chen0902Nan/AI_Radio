import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { parseEnv } from 'node:util'
import { runDev } from './lib/dev-runner.mts'

const root = path.resolve(import.meta.dirname, '..')
const apiOnly = process.argv.includes('--api-only')

async function checkPort(host: string, port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error(`${host}:${port} 已被占用，请先在旧服务的终端按 Ctrl+C，再运行 npm run dev。`))
    })
    socket.once('error', error => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? resolve() : reject(error))
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error(`无法检查 ${host}:${port}`)) })
  })
}

try {
  const envFile = path.join(root, '.env')
  if (fs.existsSync(envFile)) {
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(envFile, 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数。')
  const connectHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
  const address = `http://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}:${port}`
  await checkPort(connectHost, port)
  if (!apiOnly) await checkPort('127.0.0.1', 5173)
  const npm = (...args: string[]) => process.env.npm_execpath
    ? { file: process.execPath, args: [process.env.npm_execpath, ...args] }
    : { file: 'npm', args }
  console.log(`[dev] 后端 ${address}${apiOnly ? '' : '；浏览器请打开 http://127.0.0.1:5173'}`)
  process.exitCode = await runDev({
    cwd: root,
    build: [npm('run', 'build', '-w', '@radio/contracts'), npm('run', 'build', '-w', '@radio/api')],
    watchPaths: [
      'apps/api/src', 'apps/api/tsconfig.json', 'apps/api/tsconfig.build.json',
      'packages/contracts/src', 'packages/contracts/tsconfig.json',
      'packages/contracts/tsconfig.cjs.json', 'packages/contracts/tsconfig.esm.json',
    ],
    backend: { file: process.execPath, args: ['--env-file-if-exists=.env', '--use-env-proxy', 'apps/api/dist/main.js'] },
    frontend: apiOnly ? null : {
      ...npm('run', 'dev', '-w', '@radio/web', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'),
      env: { RADIO_API_TARGET: address },
    },
  })
} catch (error) {
  console.error('[dev]', (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}
