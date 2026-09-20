/** Offline by default: real Nest/SQLite/Chrome with local provider and media fixtures. */
import { withVerification } from './lib/verification-environment.mts'
import { runControllerUnitChecks } from './lib/orchestration-controller.mts'
import { runServerChecks, runRealCodexRefill } from './lib/orchestration-server.mts'
import { createBrowserContext } from './lib/orchestration-browser-adapter.mts'
import { runBrowserChecks } from './lib/orchestration-browser.mts'
import type { Check, Context, Report } from './lib/orchestration-types.mts'

const args = process.argv.slice(2)
// The natural-ended scenario must leave enough time to observe a slow preparation without ending the song.
process.env.RADIO_FIXTURE_SECONDS ||= '12'
await withVerification('orchestration', args, async env => {
  const report: Report = { at: new Date().toISOString(), checks: [], evidence: { fixture: env.fixture } }
  const check: Check = (name, ok, detail) => {
    report.checks.push({ name, ok: Boolean(ok), detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  }
  const context: Context = { api: env.request, post: (route, body = {}) => env.request(route, body), check, report }
  try {
    const health = await env.request('/api/health')
    if (!health.ok || !health.testHooks || !health.loggedIn) throw new Error('需要已登录的隔离服务和测试钩子')
    await runControllerUnitChecks(check, report)
    await runServerChecks(context)
    if (!env.fixture && !args.includes('--skip-real')) await runRealCodexRefill(context)
    else report.skipped = [{ name: '真实供应商调用（本地替身模式或 --skip-real）' }]
    if (!args.includes('--server-only')) await runBrowserChecks(await createBrowserContext(env, context))
    report.summary = { passed: report.checks.filter(c => c.ok).length, failed: report.checks.filter(c => !c.ok).length }
    if (report.summary.failed) throw new Error(`${report.summary.failed} 项编排验证失败`)
  } catch (error) {
    report.fatal = error instanceof Error ? error.stack : String(error)
    throw error
  } finally {
    console.log(`编排证据：${env.writeReport(report)}`)
  }
}).catch(error => { console.error(error); process.exitCode = 1 })
