import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { moveToTrash } from '../lib/trash.mts'

const cli = path.resolve('scripts/check-quality.mts')
test('质量 CLI 拒绝新增超限和例外恶化，允许不改变指标的行号移动', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-quality-gate-'))
  t.after(() => moveToTrash(root))
  fs.mkdirSync(path.join(root, 'apps'))
  const file = path.join(root, 'apps/sample.ts'), baseline = path.join(root, 'baseline.json')
  const source = 'function choose(x: number) {\n' + Array.from({ length: 11 }, (_, i) => `if (x === ${i}) return ${i}`).join('\n') + '\nreturn -1\n}\n'
  fs.writeFileSync(file, source)
  const run = () => spawnSync(process.execPath, [cli, `--root=${root}`, `--baseline=${baseline}`, '--check'], { encoding: 'utf8' })
  fs.writeFileSync(baseline, JSON.stringify({ version: 1, files: [], functions: [] }))
  assert.equal(run().status, 1, '新超限不能只打印后成功退出')
  fs.writeFileSync(baseline, JSON.stringify({ version: 1, files: [], functions: [{ file: 'apps/sample.ts', symbol: 'choose', occurrence: 0, effectiveLines: 14, complexity: 12, nesting: 1, component: false }] }))
  assert.equal(run().status, 0)
  fs.writeFileSync(file, '// comment\n\n' + source)
  assert.equal(run().status, 0, '不依赖行号')
  fs.writeFileSync(file, source.replace('return -1', 'if (x === 100) return 100\nreturn -1'))
  assert.equal(run().status, 1, '已保留的复杂度不能增长')
})

for (const [name, source] of [
  ['文件规模', Array.from({ length: 501 }, (_, i) => `const value${i} = ${i}`).join('\n')],
  ['函数规模', 'function large() {\n' + Array.from({ length: 51 }, (_, i) => `const value${i} = ${i}`).join('\n') + '\n}'],
  ['嵌套深度', 'function deep(x: boolean) { if (x) { while (x) { if (x) { while (x) {} } } } }'],
] as const) test(`质量 CLI 阻止新增${name}超限`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-quality-dimension-'))
  t.after(() => moveToTrash(root))
  fs.mkdirSync(path.join(root, 'apps'))
  fs.writeFileSync(path.join(root, 'apps/sample.ts'), source)
  const baseline = path.join(root, 'baseline.json')
  fs.writeFileSync(baseline, JSON.stringify({ version: 1, files: [], functions: [] }))
  const result = spawnSync(process.execPath, [cli, `--root=${root}`, `--baseline=${baseline}`, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /质量退步/)
})
