import ts from 'typescript'

export interface FunctionMetric {
  symbol: string; line: number; effectiveLines: number; complexity: number; nesting: number; component: boolean
}
export interface FileMetric { file: string; effectiveLines: number; functions: FunctionMetric[] }
type FunctionNode = ts.FunctionLikeDeclaration & { body: ts.ConciseBody }
const isFunction = (node: ts.Node): node is FunctionNode =>
  ts.isFunctionLike(node) && 'body' in node && node.body !== undefined

function effectiveLines(source: ts.SourceFile): Set<number> {
  const lines = new Set<number>()
  function visit(node: ts.Node): void {
    const children = node.getChildren(source)
    if (children.length) { children.forEach(visit); return }
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return
    // 使用解析后的终端 token：模板插值、正则和 JSX 的上下文由 TS parser 处理。
    const start = node.getStart(source), end = node.getEnd()
    const first = source.getLineAndCharacterOfPosition(start).line
    source.text.slice(start, end).split(/\r?\n/).forEach((text, offset) => {
      if (text.trim()) lines.add(first + offset)
    })
  }
  visit(source)
  return lines
}

function isBranch(node: ts.Node): boolean {
  return ts.isIfStatement(node) || ts.isIterationStatement(node, false) || ts.isConditionalExpression(node) || ts.isCatchClause(node)
}
function isLogical(node: ts.Node): boolean {
  return ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)
}
function symbolOf(node: FunctionNode, source: ts.SourceFile): string {
  if (node.name) return node.name.getText(source)
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name.getText(source)
  if (ts.isCallExpression(parent)) {
    const label = parent.arguments[0]
    if (label && ts.isStringLiteral(label)) return `${parent.expression.getText(source)}(${label.text})`
    return `${parent.expression.getText(source)} callback`
  }
  return '<anonymous>'
}
function isJsx(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)
}
function addsNesting(node: ts.Node): boolean {
  return isBranch(node) || ts.isSwitchStatement(node) || ts.isTryStatement(node)
}
function isDecision(node: ts.Node): boolean {
  return isBranch(node) || isLogical(node) || ts.isCaseClause(node)
}
function metric(node: FunctionNode, source: ts.SourceFile, lines: Set<number>): FunctionMetric {
  let complexity = 1, nesting = 0, jsx = false
  function walk(child: ts.Node, depth: number): void {
    if (isFunction(child)) return
    if (isJsx(child)) jsx = true
    if (isDecision(child)) complexity++
    const nested = addsNesting(child)
    // else-if 是同一层选择；catch 与 try 是并列的路径。
    const chained = ts.isIfStatement(child) && ts.isIfStatement(child.parent) && child.parent.elseStatement === child
    const next = depth + (nested && !chained ? 1 : 0)
    nesting = Math.max(nesting, next)
    ts.forEachChild(child, c => walk(c, ts.isCatchClause(c) && ts.isTryStatement(child) ? depth : next))
  }
  walk(node.body, 0)
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line
  const end = source.getLineAndCharacterOfPosition(node.getEnd() - 1).line
  const symbol = symbolOf(node, source)
  return { symbol, line: start + 1, effectiveLines: [...lines].filter(n => n >= start && n <= end).length, complexity, nesting, component: /^[A-Z]/.test(symbol) && jsx }
}
export function analyzeSource(file: string, text: string): FileMetric {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const lines = effectiveLines(source), functions: FunctionMetric[] = []
  function walk(node: ts.Node): void {
    if (isFunction(node)) functions.push(metric(node, source, lines))
    ts.forEachChild(node, walk)
  }
  walk(source)
  return { file, effectiveLines: lines.size, functions }
}
export function exceeds(metric: FunctionMetric): boolean {
  return metric.effectiveLines > (metric.component ? 200 : 50) || metric.complexity > 10 || metric.nesting > 3
}
