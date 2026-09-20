import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { withVerification, type VerificationEnvironment } from '../lib/verification-environment.mts'

for (const phase of ['prepare', 'browser', 'report'] as const) {
  test(`验证工具 ${phase} 抛错仍结束服务并清理隔离目录`, async () => {
    let captured: VerificationEnvironment | undefined
    await assert.rejects(withVerification('cleanup-test', ['--fixture'], async env => {
      captured = env
      assert.ok(fs.existsSync(env.paths.db))
      assert.notEqual(env.paths.session, `${process.cwd()}/data/session.json`)
      if (phase !== 'prepare') await env.browser()
      if (phase === 'report') env.writeReport({ evidence: 1 }, '/dev/null/not-a-file')
      throw new Error('injected failure')
    }), phase === 'report' ? /EEXIST/ : /injected failure/)
    assert.ok(captured)
    assert.equal(fs.existsSync(captured.paths.root), false)
    await assert.rejects(fetch(captured.base))
  })
}
test('无法恢复的外部服务模式在任何修改前拒绝', async () => {
  await assert.rejects(withVerification('refuse-external', ['--base=http://127.0.0.1:8787'], async () => {
    assert.fail('不得进入修改阶段')
  }), /外部服务/)
})

test('隔离工具覆盖所有数据路径，重启保留自身数据而外部数据库和登录态不变', async () => {
  const os = await import('node:os'), path = await import('node:path')
  const { moveToTrash } = await import('../lib/trash.mts')
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-outside-'))
  const db = path.join(outside, 'radio.db'), session = path.join(outside, 'session.json')
  fs.writeFileSync(db, 'untouched database'); fs.writeFileSync(session, 'untouched login')
  const saved = { db: process.env.RADIO_DB_FILE, session: process.env.RADIO_SESSION_FILE, cache: process.env.DJ_AUDIO_CACHE_DIR }
  process.env.RADIO_DB_FILE = db; process.env.RADIO_SESSION_FILE = session; process.env.DJ_AUDIO_CACHE_DIR = outside
  try {
    await withVerification('isolation-test', [], async env => {
      await env.request('/api/settings', { key: 'refillBatchSize', value: '7' })
      await env.request('/api/_test/fish-mode', { mode: 'auth' })
      await env.restart()
      const settings = await env.request('/api/settings')
      assert.ok(settings.settings && typeof settings.settings === 'object' && 'refillBatchSize' in settings.settings)
      assert.equal(settings.settings.refillBatchSize, '7')
    })
    assert.equal(fs.readFileSync(db, 'utf8'), 'untouched database')
    assert.equal(fs.readFileSync(session, 'utf8'), 'untouched login')
    assert.deepEqual(fs.readdirSync(outside).sort(), ['radio.db', 'session.json'])
  } finally {
    for (const [key, value] of Object.entries({ RADIO_DB_FILE: saved.db, RADIO_SESSION_FILE: saved.session, DJ_AUDIO_CACHE_DIR: saved.cache })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    moveToTrash(outside)
  }
})

test('浏览器退出后关闭启动管道，后台 crash reporter 继承 stderr 不会拖住验证进程', async t => {
  const { default: puppeteer } = await import('puppeteer-core')
  const { PassThrough } = await import('node:stream')
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  let closed = false
  // 模拟 Chrome 主进程已退出、派生 reporter 仍持有同一 stderr 的公开进程边界。
  const browser = { close: async () => { closed = true }, process: () => ({ stdin, stdout, stderr }) }
  t.mock.method(puppeteer, 'launch', async () => browser)
  await withVerification('browser-pipes', [], async env => { await env.browser() })
  assert.equal(closed, true)
  assert.ok(stdin.destroyed && stdout.destroyed && stderr.destroyed, '浏览器的三个启动管道均已释放')
})
