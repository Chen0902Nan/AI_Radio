/**
 * 集中配置（迁移自 server/index.js、db.js、netease.js、dj-pipeline.js 的散落常量）。
 * 路径一律解析为绝对路径：编译到 dist 后仍指向项目根 data/，不得默默创建空库或丢登录态。
 * .env 加载由启动脚本完成（--env-file-if-exists），这里只读 process.env，不覆盖已有值。
 */
import * as path from 'node:path'
import * as fs from 'node:fs'

/**
 * 项目根定位：从当前目录向上找带 workspaces 的根 package.json，
 * 不依赖编译产物的固定层级（dist/config 会被 tsc 保留目录结构）。
 */
export function projectRoot(): string {
  let dir = __dirname
  for (let i = 0; i < 8; i += 1) {
    const pkg = path.join(dir, 'package.json')
    try {
      const parsed = JSON.parse(fs.readFileSync(pkg, 'utf-8'))
      if (Array.isArray(parsed.workspaces)) return dir
    } catch (_) {}
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 兜底：按源码布局推算
  return path.resolve(__dirname, '..', '..', '..', '..')
}

export const DATA_DIR = path.join(projectRoot(), 'data')
export const DB_FILE = process.env.RADIO_DB_FILE || path.join(DATA_DIR, 'radio.db')
export const SESSION_FILE = path.join(DATA_DIR, 'session.json')
export const NCM_TMP_DIR = path.join(DATA_DIR, 'ncm-tmp')
export const DJ_AUDIO_CACHE_DIR = process.env.DJ_AUDIO_CACHE_DIR || path.join(DATA_DIR, 'dj-audio')

export const TEST_HOOKS = process.env.RADIO_TEST_HOOKS === '1'

export const SERVER = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
}

export const CODEX = {
  bin: process.env.CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex',
  timeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 90000),
}

export const FISH = {
  apiKey: (): string | null => process.env.FISH_API_KEY || process.env.FISH_AUDIO_API_KEY || null,
  base: process.env.FISH_API_BASE || 'https://api.fish.audio',
  ttsTimeoutMs: Number(process.env.FISH_TTS_TIMEOUT_MS || 60000),
}

export const DJ = {
  scriptTimeoutMs: Number(process.env.DJ_SCRIPT_TIMEOUT_MS || 90000),
  totalMs: 150000,
  retentionMs: 5 * 60 * 1000,
}
