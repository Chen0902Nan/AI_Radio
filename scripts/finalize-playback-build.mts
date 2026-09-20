import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = new URL('../apps/web/dist-playback/', import.meta.url)
// 明确产物的 CJS 边界，运行时和 d.ts 均不继承 web/package.json 的 ESM。
fs.writeFileSync(new URL('package.json', root), '{"type":"commonjs"}\n')
if (!process.argv.includes('--types-only')) {
  for (const [source, entry, reference] of [
    ['playback/playback-controller.js', 'playback-controller.cjs', './playback/playback-controller.js'],
    ['orchestration/refill-controller.js', 'orchestration/refill-controller.cjs', './refill-controller.js'],
    ['orchestration/segue-controller.js', 'orchestration/segue-controller.cjs', './segue-controller.js'],
  ]) {
    // 不移动内部模块，避免其相对依赖在拆分后指向错误目录；保留原公开入口。
    fs.accessSync(fileURLToPath(new URL(source, root)))
    fs.writeFileSync(new URL(entry, root), `module.exports = require('${reference}')\n`)
  }
}
