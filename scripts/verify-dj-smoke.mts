/** DJ smoke: real local Nest/SQLite/browser, fixture suppliers by default; no production playback globals. */
import { withVerification } from './lib/verification-environment.mts'
import { reset, type SmokeContext } from './lib/dj-smoke-browser.mts'
import { DJ_SCENARIOS } from './lib/dj-smoke-scenarios.mts'

export async function verifyDjSmoke(args = process.argv.slice(2)): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; error?: string }> = []
  // Long fixture songs leave time for assertions; scenarios end media through its public HTMLMediaElement API.
  const oldDuration = process.env.RADIO_FIXTURE_SECONDS
  process.env.RADIO_FIXTURE_SECONDS = '30'
  try {
    await withVerification('dj-smoke', args, async env => {
      if (!env.fixture) throw new Error('DJ 冒烟仅运行本地供应商替身；真实供应商验收请使用独立入口')
      const browser = await env.browser(), page = await browser.newPage()
      const errors: string[] = [], resolveRequests: string[] = []
      page.on('pageerror', error => errors.push(String(error)))
      page.on('request', request => { if (request.url().includes('/api/resolve/')) resolveRequests.push(request.url()) })
      const context: SmokeContext = { env, page, resolveRequests }
      for (const scenario of DJ_SCENARIOS) {
        try {
          await reset(context)
          await scenario.run(context)
          checks.push({ name: scenario.name, ok: true })
        } catch (error) { checks.push({ name: scenario.name, ok: false, error: String(error) }) }
        console.log(`${checks.at(-1)!.ok ? 'PASS' : 'FAIL'} ${scenario.name}${checks.at(-1)!.error ? ': ' + checks.at(-1)!.error : ''}`)
      }
      if (errors.length) checks.push({ name: '浏览器无未处理错误', ok: false, error: errors.join('\n') })
      const passed = checks.every(check => check.ok)
      console.log(env.writeReport({ at: new Date().toISOString(), scope: 'local-http-sqlite-browser-fixture', passed, checks }))
      if (!passed) throw new Error(`DJ 冒烟失败 ${checks.filter(check => !check.ok).length}/${checks.length}`)
    })
  } finally {
    if (oldDuration === undefined) delete process.env.RADIO_FIXTURE_SECONDS
    else process.env.RADIO_FIXTURE_SECONDS = oldDuration
  }
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await verifyDjSmoke().catch(error => { console.error(error); process.exitCode = 1 })
}
