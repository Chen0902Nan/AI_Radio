import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = new URL('../apps/web/dist-playback/', import.meta.url)
for (const [from, to] of [
  ['playback/playback-controller.js', 'playback-controller.cjs'],
  ['orchestration/refill-controller.js', 'orchestration/refill-controller.cjs'],
  ['orchestration/segue-controller.js', 'orchestration/segue-controller.cjs'],
]) {
  // 缺少本次 tsc 产物必须失败，不能继续测试上一次遗留的 .cjs。
  fs.renameSync(fileURLToPath(new URL(from, root)), fileURLToPath(new URL(to, root)))
}
