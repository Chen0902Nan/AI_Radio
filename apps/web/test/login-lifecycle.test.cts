const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
require('./support/runtime.cts')
const { LoginLifecycle }: typeof import('../dist-playback/orchestration/login-lifecycle.js') = require('../src/orchestration/login-lifecycle.ts')

test('新二维码返回后，旧二维码请求不能覆盖它；离开页面取消请求', async () => {
  const requests: Array<{ resolve: (value: unknown) => void; signal: AbortSignal }> = []
  const login = new LoginLifecycle({
    request: (_path, signal) => new Promise(resolve => requests.push({ resolve, signal })),
    navigate: () => assert.fail('不应跳转'),
  })
  const old = login.start()
  const current = login.start('手动刷新')
  assert.equal(requests[0].signal.aborted, true)
  requests[1].resolve({ key: 'new', qrimg: 'new.png' })
  await current
  requests[0].resolve({ key: 'old', qrimg: 'old.png' })
  await old
  assert.equal(login.getSnapshot().qrImg, 'new.png')
  login.dispose()
  assert.equal(requests[1].signal.aborted, true)
})

test('旧轮询成功与过期不能触发新一轮跳转或刷新，慢轮询不重叠', async () => {
  for (const code of [800, 803]) {
    let oldPoll!: (value: unknown) => void
    let qrRequests = 0, polls = 0, navigations = 0
    const login = new LoginLifecycle({
      request: async path => {
        if (path === '/api/login/qr') return { key: String(++qrRequests), qrimg: `${qrRequests}.png` }
        polls++
        return new Promise(resolve => { oldPoll = resolve })
      },
      navigate: () => { navigations++ }, pollIntervalMs: 5, redirectMs: 5,
    })
    await login.start()
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(polls, 1)
    await login.start('手动刷新')
    oldPoll({ code, account: { nickname: 'old' } })
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(qrRequests, 2)
    assert.equal(navigations, 0)
    assert.equal(login.getSnapshot().qrImg, '2.png')
    login.dispose()
  }
})

test('StrictMode 建立清理再建立和成功后离开，均只保留当前生命周期', async () => {
  let qr = 0, polls = 0, navigations = 0
  const login = new LoginLifecycle({
    request: async path => path === '/api/login/qr'
      ? { key: String(++qr), qrimg: `${qr}.png` }
      : (++polls, { code: 803 }),
    navigate: () => { navigations++ }, pollIntervalMs: 5, redirectMs: 30,
  })
  const first = login.start()
  login.dispose()
  await login.start()
  await first
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(polls, 1)
  assert.match(login.getSnapshot().status, /登录成功/)
  login.dispose()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(navigations, 0)
})
