import type { FileMetric, FunctionMetric } from './quality-report.mts'

interface Entry extends Omit<FunctionMetric, 'line'> { file: string; occurrence: number }
interface Baseline { version: 1; files: Array<{ file: string; effectiveLines: number }>; functions: Entry[] }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效质量基线对象')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('无效质量基线名称')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('无效质量基线指标')
  return value
}
function entry(value: unknown): Entry {
  const v = object(value)
  if (typeof v.component !== 'boolean') throw new Error('无效组件标识')
  return { file: text(v.file), symbol: text(v.symbol), occurrence: integer(v.occurrence), effectiveLines: integer(v.effectiveLines), complexity: integer(v.complexity), nesting: integer(v.nesting), component: v.component }
}
export function parseBaseline(value: unknown): Baseline {
  const v = object(value)
  if (v.version !== 1 || !Array.isArray(v.files) || !Array.isArray(v.functions)) throw new Error('无效质量基线版本或条目')
  const files = v.files.map(value => { const f = object(value); return { file: text(f.file), effectiveLines: integer(f.effectiveLines) } })
  return { version: 1, files, functions: v.functions.map(entry) }
}
function key(file: string, symbol: string, occurrence: number): string {
  return JSON.stringify([file, symbol, occurrence])
}
function violations(current: FunctionMetric, previous?: Entry): string[] {
  const limits = {
    effectiveLines: Math.max(current.component ? 200 : 50, previous?.effectiveLines ?? 0),
    complexity: Math.max(10, previous?.complexity ?? 0),
    nesting: Math.max(3, previous?.nesting ?? 0),
  }
  return (Object.keys(limits) as Array<keyof typeof limits>)
    .filter(metric => current[metric] > limits[metric])
    .map(metric => `${metric}=${current[metric]} > ${limits[metric]}`)
}

/** 文件+符号+同名出现序号作为标识；行号仅展示，新增匿名同名操作会保守要求复审。 */
export function qualityRegressions(report: FileMetric[], baseline: Baseline): string[] {
  const known = new Map(baseline.functions.map(f => [key(f.file, f.symbol, f.occurrence), f]))
  const files = new Map(baseline.files.map(f => [f.file, f.effectiveLines]))
  const failures: string[] = []
  for (const file of report) {
    if (file.effectiveLines > Math.max(500, files.get(file.file) ?? 0)) failures.push(`${file.file}: 文件规模增长为 ${file.effectiveLines}`)
    const occurrences = new Map<string, number>()
    for (const f of file.functions) {
      const occurrence = occurrences.get(f.symbol) ?? 0
      occurrences.set(f.symbol, occurrence + 1)
      const issues = violations(f, known.get(key(file.file, f.symbol, occurrence)))
      if (issues.length) failures.push(`${file.file}:${f.line} ${f.symbol}: ${issues.join(', ')}`)
    }
  }
  return failures
}
