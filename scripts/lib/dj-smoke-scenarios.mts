import assert from 'node:assert/strict'
import { click, driveToSegue, media, nextWithEvent, observation, play, preview, seekEnd, sleep, toggleDj, waitFor, waitTrack, type SmokeContext } from './dj-smoke-browser.mts'

export interface DjScenario { name: string; run(ctx: SmokeContext): Promise<void> }
async function songSegueSong(ctx: SmokeContext): Promise<void> {
  await driveToSegue(ctx)
  assert.equal((await observation(ctx.page)).segue.naturalCount, 0)
  assert.ok(await ctx.page.$eval('main', el => el.textContent.includes('验证歌曲4')))
  assert.ok((await ctx.page.$$('a[target="_blank"]')).length > 0)
  const feedbackDisabled = await ctx.page.$$eval('button', buttons => buttons.filter(b => ['喜欢', '不喜欢'].includes(b.textContent.trim())).every(b => b.disabled))
  assert.equal(feedbackDisabled, true)
  await click(ctx.page, '下一首'); await waitTrack(ctx.page, 3)
  assert.equal((await observation(ctx.page)).segue.naturalCount, 0)
  await click(ctx.page, '停止')
  await waitFor(async () => (await observation(ctx.page)).segue.stopped, '停止清空 DJ')
}
async function restart(ctx: SmokeContext): Promise<void> {
  await play(ctx, 1)
  const before = await observation(ctx.page)
  const history = await ctx.env.request('/api/plays/history')
  await click(ctx.page, '停止')
  await waitFor(async () => (await observation(ctx.page)).sessionId === null, '停止会话')
  await click(ctx.page, '开播'); await waitTrack(ctx.page, 1)
  assert.notEqual((await observation(ctx.page)).sessionId, before.sessionId)
  const after = await ctx.env.request('/api/plays/history')
  assert.ok(Array.isArray(history.recent) && Array.isArray(after.recent))
  assert.equal(after.recent.length, history.recent.length + 1)
}
async function staleEnded(ctx: SmokeContext, replay = false): Promise<void> {
  await play(ctx, 1)
  const before = await observation(ctx.page)
  await nextWithEvent(ctx.page, 'ended', replay)
  await waitTrack(ctx.page, replay ? 1 : 2)
  await sleep(100)
  const after = await observation(ctx.page)
  assert.equal(after.index, replay ? 1 : 2)
  assert.equal(after.segue.naturalCount, before.segue.naturalCount)
}
async function latePreview(ctx: SmokeContext, stop: boolean): Promise<void> {
  const response = ctx.page.waitForResponse(res => res.url().endsWith('/api/dj/preview'))
  await preview(ctx, 600)
  await play(ctx)
  await click(ctx.page, stop ? '停止' : '暂停')
  await response
  await sleep(150)
  const audio = await media(ctx.page)
  assert.equal(audio.paused, true)
  assert.ok(!audio.src.includes('/api/dj/audio/'))
  assert.equal((await observation(ctx.page)).userWantsPlayback, false)
}
async function pauseResumeDj(ctx: SmokeContext): Promise<void> {
  await driveToSegue(ctx)
  const history = await ctx.env.request('/api/plays/history')
  await click(ctx.page, '暂停')
  const before = await media(ctx.page)
  assert.equal(before.paused, true)
  await click(ctx.page, '继续')
  await waitFor(async () => (await media(ctx.page)).time > before.time + 0.05, '恢复 DJ 原位置')
  assert.equal((await media(ctx.page)).src, before.src)
  assert.deepEqual((await ctx.env.request('/api/plays/history')).recent, history.recent)
  await seekEnd(ctx.page); await waitTrack(ctx.page, 3)
}
async function pausedError(ctx: SmokeContext): Promise<void> {
  await driveToSegue(ctx); await click(ctx.page, '暂停')
  await ctx.page.$eval('audio', audio => audio.dispatchEvent(new Event('error')))
  await sleep(100)
  assert.equal((await media(ctx.page)).paused, true)
  assert.equal((await observation(ctx.page)).userWantsPlayback, false)
  await click(ctx.page, '继续')
  await waitFor(async () => !(await media(ctx.page)).paused, '错误后用户主动继续')
}
async function disableDj(ctx: SmokeContext): Promise<void> {
  await driveToSegue(ctx); await click(ctx.page, '暂停')
  const before = await media(ctx.page)
  await toggleDj(ctx.page, false)
  await sleep(100)
  assert.equal((await media(ctx.page)).src, before.src)
  assert.equal((await media(ctx.page)).paused, true)
  await click(ctx.page, '继续'); await seekEnd(ctx.page); await waitTrack(ctx.page, 3)
  await waitFor(async () => {
    const result = await ctx.env.request('/api/settings')
    return !!result.settings && typeof result.settings === 'object' && 'djEnabled' in result.settings && result.settings.djEnabled === 'false'
  }, '关闭设置已保存')
}
async function normalPreview(ctx: SmokeContext): Promise<void> {
  await preview(ctx)
  await waitFor(async () => { const audio = await media(ctx.page); return audio.src.includes('/api/dj/audio/') && !audio.paused && audio.time > 0.05 }, '试听出声')
  await seekEnd(ctx.page)
  await waitFor(async () => (await media(ctx.page)).paused, '试听结束')
  assert.equal((await observation(ctx.page)).sessionId, null)
  assert.equal((await observation(ctx.page)).segue.naturalCount, 0)
}
async function previewThenPick(ctx: SmokeContext): Promise<void> {
  await preview(ctx)
  await waitFor(async () => !(await media(ctx.page)).paused, '试听出声')
  await play(ctx, 1)
  assert.ok((await observation(ctx.page)).sessionId)
  assert.ok((await media(ctx.page)).src.includes('/api/audio/2'))
}
async function staleError(ctx: SmokeContext): Promise<void> {
  await driveToSegue(ctx)
  const requests = ctx.resolveRequests.length
  await nextWithEvent(ctx.page, 'error')
  await waitTrack(ctx.page, 3)
  assert.equal(ctx.resolveRequests.length, requests + 1)
}
async function currentError(ctx: SmokeContext): Promise<void> {
  await play(ctx, 1)
  const requests = ctx.resolveRequests.length
  await ctx.page.$eval('audio', audio => audio.dispatchEvent(new Event('error')))
  await waitFor(async () => ctx.resolveRequests.length > requests, '当前媒体错误刷新音源')
  await waitTrack(ctx.page, 1)
}
export const DJ_SCENARIOS: DjScenario[] = [
  { name: '歌曲→DJ→目标歌曲、来源展示和自然计数', run: songSegueSong },
  { name: '停止后重开创建新会话和播放记录', run: restart },
  { name: '切歌期间旧 ended 不跳歌或计数', run: ctx => staleEnded(ctx) },
  { name: '迟到试听不越过收听暂停', run: ctx => latePreview(ctx, false) },
  { name: 'DJ 暂停恢复不重复记账', run: pauseResumeDj },
  { name: '暂停时媒体错误不自动播放', run: pausedError },
  { name: '关闭 DJ 不打断已出声串场', run: disableDj },
  { name: '正常试听可播放并自然结束', run: normalPreview },
  { name: '开播后又停止使迟到试听失效', run: ctx => latePreview(ctx, true) },
  { name: '试听中点歌建立正常播放记录', run: previewThenPick },
  { name: '重播同一首时旧 ended 不跳歌', run: ctx => staleEnded(ctx, true) },
  { name: '旧 DJ 的 error 不额外刷新新歌', run: staleError },
  { name: '当前媒体 error 仍刷新且继续当前歌', run: currentError },
]
