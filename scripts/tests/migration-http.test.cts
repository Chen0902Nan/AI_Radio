import type { Request, Response } from 'express'
import type { NeteaseService, Track, ResolvedTrack } from '../../apps/api/dist/music/netease.service.js'
import type { CodexService } from '../../apps/api/dist/codex/codex.service.js'
import type { DbService } from '../../apps/api/dist/persistence/db.service.js'
import type { EventsService } from '../../apps/api/dist/events/events.service.js'
const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
process.env.RADIO_TEST_HOOKS = '1'
const { TestHooksController }: typeof import('../../apps/api/dist/test-support/test-hooks.controller.js') = require('../../apps/api/dist/test-support/test-hooks.controller.js')
const { MusicController }: typeof import('../../apps/api/dist/music/music.controller.js') = require('../../apps/api/dist/music/music.controller.js')
const { PreparationController }: typeof import('../../apps/api/dist/preparation/preparation.controller.js') = require('../../apps/api/dist/preparation/preparation.controller.js')
const { StaticController }: typeof import('../../apps/api/dist/http/static.controller.js') = require('../../apps/api/dist/http/static.controller.js')
const { OrchestratorService }: typeof import('../../apps/api/dist/preparation/orchestrator.service.js') = require('../../apps/api/dist/preparation/orchestrator.service.js')
const { Writable }: typeof import('node:stream') = require('node:stream')

// Each route touches a subset of its service. Partial<T> validates fixture signatures before this local constructor adaptation.
function partial<T>(fixture: Partial<T>): T { return fixture as T }
function response(): Response & { body: string } {
  let body = ''
  const stream = new Writable({ write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { body += chunk.toString(); done() } })
  const result = Object.assign(stream, {
    get body() { return body }, statusCode: 200, headers: {} as Record<string, string>,
    status(code: number) { result.statusCode = code; return result },
    header(name: string, value: string) { result.headers[name] = value; return result },
    writeHead(code: number, headers: Record<string, string>) { result.statusCode = code; Object.assign(result.headers, headers); return result },
  })
  // Writable supplies pipe/finish; this boundary supplies the Express response methods used by these controllers.
  Object.defineProperty(result, 'body', { get: () => body })
  return result as unknown as Response & { body: string }
}
function json(response: { body: string }): Record<string, unknown> {
  const value: unknown = JSON.parse(response.body)
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
const hooks = () => new TestHooksController(partial<NeteaseService>({}), partial<CodexService>({}), partial<InstanceType<typeof OrchestratorService>>({}))
const source = (id = 1, kind: ResolvedTrack['kind'] = 'full'): ResolvedTrack => ({ id, kind, identity: 'fixture', url: null, br: 0, size: 0, type: null, level: null, freeTrialInfo: null, expiresAt: 0, cached: false })
const song = (id: number): Track => ({ id, name: '曲' + id, artists: '', album: '', durationMs: 1000 })

test('fail-next只令下一次音源解析失败，消费后恢复正常', async () => {
  hooks().failNext(response(), { count: 1 })
  const music = new MusicController(partial<NeteaseService>({ resolveTrack: async id => source(Number(id)) }))
  const first = response(); await music.resolve(first, '123', ''); assert.equal(first.statusCode, 502)
  const second = response(); await music.resolve(second, '123', ''); assert.equal(second.statusCode, 200)
  assert.equal(json(second).playable, true)
})

test('fail-audio-next令音频流失败一次，之后恢复音源实际结果', async () => {
  hooks().failAudioNext(response(), { count: 1 })
  const music = new MusicController(partial<NeteaseService>({ resolveTrack: async () => source(1, 'none') }))
  const request = partial<Request>({ headers: {} })
  const first = response(); await music.audio(request, first, '1'); assert.equal(first.statusCode, 502)
  assert.equal(json(first).code, 'injected_audio_failure')
  const second = response(); await music.audio(request, second, '1'); assert.equal(second.statusCode, 409)
})

test('强制补歌失败返回指定错误且只消费配置次数', async () => {
  hooks().refillForced(response(), { count: 1, code: 'candidates_exhausted', message: '候选耗尽' })
  const controller = new PreparationController(partial<NeteaseService>({ loadSession: () => null }), partial<InstanceType<typeof OrchestratorService>>({}), partial<DbService>({}))
  const first = response(); await controller.refill(first, {}); assert.equal(first.statusCode, 409)
  assert.equal(json(first).code, 'candidates_exhausted')
  const second = response(); await controller.refill(second, {}); assert.equal(second.statusCode, 401)
})

test('强制补歌曲目经过可播性检查且只影响指定批次', async () => {
  hooks().refillForcedPicks(response(), { count: 1, ids: [11, 12] })
  const ncm = partial<NeteaseService>({
    loadSession: () => ({ cookie: 'fixture', savedAt: 'now', profile: null }), currentIdentity: () => 'forced-fixture',
    selectionLibrary: async () => ({ complete: true, tracks: [song(11), song(12)] }),
    getLikedIds: async () => [11, 12], getLikedTracks: async () => [song(11), song(12)],
  })
  const db = partial<DbService>({ getNumberSetting: () => 5 })
  const orchestrator = new OrchestratorService(partial<NeteaseService>({ resolveTrack: async id => source(Number(id), Number(id) === 11 ? 'full' : 'none') }), partial<CodexService>({}), db, partial<EventsService>({}))
  const controller = new PreparationController(ncm, orchestrator, db)
  const first = response(); await controller.refill(first, { sessionId: 's', epoch: 1 }); assert.equal(first.statusCode, 200)
  const data = json(first); assert.ok(Array.isArray(data.picks))
  assert.deepEqual(data.picks.map((pick: unknown) => { assert.ok(pick && typeof pick === 'object' && 'id' in pick); return pick.id }), [11])
  assert.equal(data.source, 'forced')
  ncm.loadSession = () => null
  const second = response(); await controller.refill(second, {}); assert.equal(second.statusCode, 401)
})

test('未知API保持404，网页深链接仍返回React页面', async () => {
  const controller = new StaticController()
  const missing = response(); controller.serve(partial<Request>({ path: '/api/does-not-exist', method: 'GET' }), missing); assert.equal(missing.statusCode, 404)
  const page = response(); controller.serve(partial<Request>({ path: '/login', method: 'GET' }), page); assert.equal(page.statusCode, 200)
  await new Promise(resolve => page.on('finish', resolve)); assert.ok(page.body.includes('id="root"'))
})

test('无效登录态账号不能传到供应商或作为曲库归属', async () => {
  let supplierCalls = 0
  const ncm = partial<NeteaseService>({
    loadSession: () => ({ cookie: 'MUSIC_U=fixture', savedAt: 'now', profile: { userId: { bad: 1 } } }),
    getLikedIds: async () => { supplierCalls++; return [] }, getLikedTracks: async () => [],
    getUserPlaylists: async () => { supplierCalls++; return { created: [], collected: [], total: 0, pages: [], complete: true } },
    whoami: async () => null,
  })
  const res = response()
  await new MusicController(ncm).library(res)
  assert.equal(res.statusCode, 401)
  assert.equal(json(res).code, 'NOT_LOGGED_IN')
  assert.equal(supplierCalls, 0)
})
