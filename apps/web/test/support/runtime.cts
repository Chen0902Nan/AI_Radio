import type { TestContext } from 'node:test'
import type { TrackItem, PlayStartRequest, SessionInfo } from '@radio/contracts'
const fs: typeof import('node:fs') = require('node:fs')
const ts: typeof import('typescript') = require('typescript')
// 运行加载保留 CJS 顺序；静态接口来自同一次 build:types 生成的声明。
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (mod, file) => {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  // Node 的私有 CJS 编译入口没有在 NodeModule 中声明，仅在加载器接入点适配。
  ;(mod as NodeModule & { _compile(source: string, filename: string): void })._compile(compiled, file)
}
const { makeTrackItem }: typeof import('@radio/contracts') = require('@radio/contracts')
const { api }: typeof import('../../dist-playback/api/client.js') = require('../../src/api/client.ts')
type Api = typeof api
type WithoutStatus<T> = T extends unknown ? Omit<T, 'status'> & { status?: number } : never
type FixtureApi = { [K in keyof Api]: (...args: Parameters<Api[K]>) => Promise<WithoutStatus<Awaited<ReturnType<Api[K]>>>> }
interface PlayRecord extends PlayStartRequest { id: number; outcome: string | null }
const item = (id: number): TrackItem => makeTrackItem({ id, name: `曲${id}`, artists: '歌手', durationMs: 200000 })
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)) }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function deferredFor<K extends keyof Api>(_method: K) { return deferred<WithoutStatus<Awaited<ReturnType<Api[K]>>>>() }
const sessionInfo = (id: string): SessionInfo => ({ id, adjustments: {}, highest_epoch: 0, transition_seq: -1 })
function fakeAudio() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    paused: true, currentTime: 0, duration: 200, readyState: 4, src: '', currentSrc: '', error: null,
    addEventListener(name: string, fn: () => void) { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set) },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn) },
    removeAttribute() { this.src = ''; this.currentSrc = '' },
    play(): Promise<void> { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true },
    emit(name: string) { if (name === 'playing') this.currentSrc = this.src; if (name === 'ended') this.paused = true; for (const fn of listeners.get(name) || []) fn() },
  }
}
function fixtureApi(records: PlayRecord[], overrides: Partial<FixtureApi>): Partial<FixtureApi> {
  let session = 1
  return {
    resolve: async id => ({ ok: true, playable: true, audioUrl: '/api/audio/' + id }),
    sessionStart: async () => ({ ok: true, session: sessionInfo('s' + session) }),
    sessionStop: async () => { session++; return { ok: true } },
    session: async () => ({ ok: true, session: sessionInfo('s' + session) }),
    settings: async () => ({ ok: true, settings: { djEnabled: 'false' } }),
    feedback: async () => ({ ok: true, active: [] }),
    playStart: async data => { const row: PlayRecord = { id: records.length + 1, ...data, outcome: null }; records.push(row); return { ok: true, playId: row.id, session: sessionInfo('s' + session) } },
    playEnd: async (id, outcome) => { const row = records.find(r => r.id === id); if (row) row.outcome = outcome; return { ok: true } },
    refill: async () => ({ ok: true, picks: [{ id: 999, name: '补入曲', artists: '歌手', reason: '' }] }),
    ...overrides,
  }
}
function setup(t: Pick<TestContext, 'after'>, ids = [101, 102], overrides: Partial<FixtureApi> = {}) {
  const audio = fakeAudio(), saved = { ...api }, savedDocument = global.document
  const records: PlayRecord[] = []
  // Fixture 已按生产方法参数/结果类型检查；补齐 HTTP status 后安装在真实 API 对象上。
  const fixtures = fixtureApi(records, overrides)
  for (const [key, call] of Object.entries(fixtures)) {
    Object.defineProperty(api, key, { configurable: true, enumerable: true, writable: true, value: async (...args: unknown[]) => {
      const result = await Reflect.apply(call, undefined, args)
      return { status: 200, ...result }
    } })
  }
  // 仅 DOM 适配点省略未被播放器使用的浏览器成员，不削弱 runtime/API 类型。
  global.document = { getElementById: () => audio } as unknown as Document
  const runtimeFile = require.resolve('../../src/orchestration/radio-runtime.ts'); delete require.cache[runtimeFile]
  const file = require.resolve('../../src/app/radio-context.tsx'); delete require.cache[file]
  const { getRadioInstance }: typeof import('../../dist-playback/orchestration/radio-runtime.js') = require(runtimeFile)
  const runtime = getRadioInstance()
  runtime.segue.setConfig({ djEnabled: false })
  runtime.playback.replaceQueue(ids.map(item))
  t.after(() => { runtime.preview.stop(); runtime.settings.invalidateReads(); runtime.playback.dispose(); runtime.refill.cancel(); Object.assign(api, saved); global.document = savedDocument })
  return { runtime, audio, records, api }
}

export type RuntimeSupport = { item: typeof item; flush: typeof flush; deferred: typeof deferred; deferredFor: typeof deferredFor; sessionInfo: typeof sessionInfo; fakeAudio: typeof fakeAudio; setup: typeof setup }
module.exports = { item, flush, deferred, deferredFor, sessionInfo, fakeAudio, setup }
