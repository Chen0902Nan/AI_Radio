/**
 * 测试/验证脚本的临时目录清理：移入系统废纸篓，不自动清空（项目规则，
 * 见 .scratch/dj-segue/contract.md 第 4 节）。~/.Trash 不可用时退回目标旁的 .trash 目录。
 * 与 server/dj-audio-cache.js 的淘汰策略保持同一规则；这里面向目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function moveToTrash(target: string) {
  if (!fs.existsSync(target)) return null
  const candidates = [path.join(os.homedir(), '.Trash'), path.join(path.dirname(target), '.trash')]
  for (const base of candidates) {
    try {
      fs.mkdirSync(base, { recursive: true })
      const dest = path.join(base, `${path.basename(target)}.${Date.now()}.trash`)
      fs.renameSync(target, dest)
      return dest
    } catch (_) {}
  }
  throw new Error(`无法把 ${target} 移入废纸篓`)
}
