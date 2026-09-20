import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSource } from '../lib/quality-report.mts'

test('复杂度按独立函数计算，JSX 不增加控制流深度', () => {
  const report = analyzeSource('fixture.tsx', `// comment
function Panel() {
  const child = () => { if (true) { while (false) {} } }
  return <div>{true ? <span/> : null}</div>
}
`)
  const outer = report.functions.find(f => f.symbol === 'Panel')!
  const inner = report.functions.find(f => f.symbol === 'child')!
  assert.equal(outer.complexity, 2)
  assert.equal(outer.nesting, 1)
  assert.equal(outer.component, true)
  assert.equal(inner.complexity, 3)
  assert.equal(inner.nesting, 2)
  assert.equal(report.effectiveLines, 4)
})

test('只排除空白/纯注释，字符串中的注释标记保留，else if 不额外嵌套', () => {
  const report = analyzeSource('fixture.ts', `/* multi
comment */
const text = "// literal";
function choose(v: number) {
 if (v > 1) return true
 else if (v < 0) return false
 return v === 0 || v === 1
}
`)
  assert.equal(report.effectiveLines, 6)
  assert.equal(report.functions[0].complexity, 4)
  assert.equal(report.functions[0].nesting, 1)
})

test('模板插值和正则不会把后续注释当作代码行', () => {
  const text = [
    'const value = `hello ${name}`',
    '// comment after template',
    '',
    'function example() {',
    '  // inner comment',
    '  return /https?:\\/\\//.test(value)',
    '}',
  ].join('\n')
  const report = analyzeSource('fixture.ts', text)
  assert.equal(report.effectiveLines, 4)
  assert.equal(report.functions[0].effectiveLines, 3)
})
