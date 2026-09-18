#!/usr/bin/env node
/**
 * ESM 相对导入补扩展名：tsc 不改写 import 路径，但 Node ESM 要求显式 .js 扩展名。
 * 只处理 dist/esm 内 .js 文件里指向同包相对路径的导入（contracts 无跨文件导入，
 * 此脚本主要为后续多文件模块准备）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'contracts/dist/esm')

function walk(d: string) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name.endsWith('.js')) fixFile(p)
  }
}

function fixFile(p: fs.PathOrFileDescriptor) {
  const src = fs.readFileSync(p, 'utf-8')
  const fixed = src.replace(
    /(from\s+['"])(\.\.?\/[^'"]+?)(?<!\.js)(['"])/g,
    (_, q, spec, end) => `${q}${spec}.js${end}`,
  )
  if (fixed !== src) fs.writeFileSync(p, fixed)
  // 空目录占位：tsc 没有可导出内容时保证目录存在
}

if (fs.existsSync(dir)) walk(dir)
