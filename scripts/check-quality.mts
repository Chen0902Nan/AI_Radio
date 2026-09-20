import fs from 'node:fs'
import path from 'node:path'
import { parseBaseline, qualityRegressions } from './lib/quality-gate.mts'
import { analyzeSource, exceeds, type FileMetric } from './lib/quality-report.mts'

const args = process.argv.slice(2)
const root = path.resolve(args.find(a => a.startsWith('--root='))?.slice(7) || path.join(import.meta.dirname, '..'))
const excluded = new Set(['node_modules', 'dist', 'dist-playback', '.git', '.scratch', '.trash'])
function sources(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name)) return []
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(file)
    return /\.(?:tsx?|mts|cts)$/.test(file) ? [file] : []
  })
}
const files = ['apps', 'packages', 'scripts'].flatMap(dir => sources(path.join(root, dir))).sort()
const report: FileMetric[] = files.map(file => analyzeSource(path.relative(root, file), fs.readFileSync(file, 'utf8')))
const output = args.find(a => a.startsWith('--out='))?.slice(6)
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
console.log('有效行排除空白与纯注释；复杂度=1+分支/循环/catch/条件表达式/非default case/&&/||/??；内嵌函数独立计数；JSX不增加深度。')
for (const file of report) {
  if (file.effectiveLines > 500) console.log(`${file.file}:1 [file] lines=${file.effectiveLines} > 500`)
  for (const f of file.functions.filter(exceeds)) console.log(`${file.file}:${f.line} ${f.symbol} lines=${f.effectiveLines} complexity=${f.complexity} nesting=${f.nesting}${f.component ? ' component' : ''}`)
}
console.log(`审查报告：${report.length} 个文件，${report.reduce((n, f) => n + f.functions.filter(exceeds).length, 0)} 个函数超限；此命令不设硬门禁。`)

if (args.includes('--check')) {
  const baselinePath = path.resolve(args.find(a => a.startsWith('--baseline='))?.slice(11) ?? path.join(root, 'docs/quality-baseline.json'))
  const baseline: unknown = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  const failures = qualityRegressions(report, parseBaseline(baseline))
  if (failures.length) {
    console.error('质量退步：\n' + failures.join('\n'))
    process.exitCode = 1
  } else console.log('增量质量检查通过：没有新增超限或超过已登记上限。')
}
