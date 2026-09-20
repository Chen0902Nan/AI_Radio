import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { collectFailures, type LibraryReport } from './library-checks.mts'
import type { ProbeContext } from './probe-runner.mts'

export async function cacheFixes(ctx: ProbeContext): Promise<void> {
  const resolve = (force = false) => ctx.env.request('/api/resolve/1' + (force ? '?force=1' : ''))
  await resolve()
  const cached = await resolve()
  ctx.check('C 同身份重复解析命中缓存', cached.cached === true && cached.kind === 'full')
  await ctx.env.request('/api/_test/unplayable-next', { count: 1 })
  const unavailable = await resolve(true)
  ctx.check('C 强制刷新明确不可播放', unavailable.status === 200 && unavailable.playable === false && unavailable.code === 'unplayable')
  const restored = await resolve()
  ctx.check('C 旧缓存失效，重新查询完整音源', restored.cached === false && restored.kind === 'full')
}
export async function identityFixes(ctx: ProbeContext): Promise<void> {
  const session = fs.readFileSync(ctx.env.paths.session)
  try {
    await ctx.env.request('/api/resolve/1')
    const cached = await ctx.env.request('/api/resolve/1')
    assert.equal(cached.cached, true)
    assert.equal(cached.identityKind, 'user')
    await ctx.env.request('/api/logout', {})
    const anonymous = await ctx.env.request('/api/resolve/1')
    ctx.check('D 退出后不复用旧身份缓存', anonymous.cached !== true && anonymous.identityKind === 'anon')
  } finally { fs.writeFileSync(ctx.env.paths.session, session, { mode: 0o600 }) }
  const restored = await ctx.env.request('/api/resolve/1')
  ctx.check('D 隔离登录态恢复且不复用游客缓存', restored.identityKind === 'user' && restored.cached === false)
}
export function libraryAssertions(ctx: ProbeContext): void {
  const clean: LibraryReport = {
    liked: { idsReturned: 5, idsUnique: 5, tracksReturned: 5, missingDetails: 0 },
    pagination: { consistent: true }, playlistTracks: [{ id: 1, name: 'a', complete: true, returned: 3, unique: 3 }],
    playability: { distribution: { full: 3, trial: 0, none: 0, error: 0 } }, steps: [{ step: 'liked', ok: true }],
  }
  const cases: LibraryReport[] = [
    { ...clean, liked: { ...clean.liked!, missingDetails: 3 } },
    { ...clean, liked: { ...clean.liked!, idsReturned: 6 } },
    { ...clean, pagination: { consistent: false } },
    { ...clean, playlistTracks: [{ id: 9, name: 'b', error: 'code=500' }] },
    { ...clean, playlistTracks: [{ id: 9, name: 'b', complete: false, returned: 1, declaredTrackCount: 5 }] },
    { ...clean, playability: { distribution: { full: 1, error: 2 } } },
    { ...clean, steps: [{ step: 'liked', ok: false }] }, { ...clean, blocked: '未登录' },
  ]
  ctx.check('E 资料判定接受完整报告并拒绝八类不完整报告', collectFailures(clean).length === 0 && cases.every(report => collectFailures(report).length > 0))
}
export function libraryExitCode(ctx: ProbeContext): void {
  const backup = ctx.env.paths.session + '.selftest-backup'
  fs.renameSync(ctx.env.paths.session, backup)
  try {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../read-library.mts')], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, RADIO_DATA_DIR: ctx.env.paths.root, RADIO_SESSION_FILE: ctx.env.paths.session, RADIO_DB_FILE: ctx.env.paths.db, DJ_AUDIO_CACHE_DIR: ctx.env.paths.cache, RADIO_REPORT_OUT: path.join(ctx.env.paths.root, 'library-report') },
    })
    ctx.check('E 真实资料读取入口缺登录态退出码为 2', !result.error && result.status === 2, { status: result.status, error: result.error?.message })
  } finally { fs.renameSync(backup, ctx.env.paths.session); fs.chmodSync(ctx.env.paths.session, 0o600) }
}
