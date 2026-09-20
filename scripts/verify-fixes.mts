/** Regression probes use an isolated service and the current visible UI. */
import { runProbe, failed } from './lib/probe-runner.mts'
import { browserFixes } from './lib/fixes-browser.mts'
import { cacheFixes, identityFixes, libraryAssertions, libraryExitCode } from './lib/fixes-boundaries.mts'

const oldDuration = process.env.RADIO_FIXTURE_SECONDS
process.env.RADIO_FIXTURE_SECONDS = '30'
try {
  await runProbe('fixes-regression', async context => {
    if (!context.env.fixture) throw new Error('故障注入回归仅支持本地供应商替身')
    await browserFixes(context)
    await cacheFixes(context)
    await identityFixes(context)
    libraryAssertions(context)
    libraryExitCode(context)
  })
} catch (error) { failed(error) }
finally {
  if (oldDuration === undefined) delete process.env.RADIO_FIXTURE_SECONDS
  else process.env.RADIO_FIXTURE_SECONDS = oldDuration
}
