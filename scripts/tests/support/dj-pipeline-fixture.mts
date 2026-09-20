import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DjPipelineDeps } from '../../../apps/api/dist/dj/pipeline.js'
import type { FishService } from '../../../apps/api/dist/dj/fish.service.js'
import { moveToTrash } from '../../lib/trash.mts'

const require = createRequire(import.meta.url)
// 迁移后测试目标：apps/api/src 的 TS 实现（原 server/dj-pipeline.js 等）
const contract: typeof import('@radio/contracts') = require('@radio/contracts')
const fishMod: typeof import('../../../apps/api/dist/dj/fish.service.js') = require('../../../apps/api/dist/dj/fish.service.js')
const cacheMod: typeof import('../../../apps/api/dist/dj/audio-cache.js') = require('../../../apps/api/dist/dj/audio-cache.js')

export function deferred<T = Record<string, unknown>>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
export const flush = () => new Promise((r) => setImmediate(r))
export const sleep = (ms: number|undefined) => new Promise((r) => setTimeout(r, ms))

export function makeDeps(over: Partial<DjPipelineDeps> & { fishAutoResolve?: boolean | Awaited<ReturnType<FishService['synthesize']>> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-pipe-'))
  const scriptCalls: Parameters<NonNullable<DjPipelineDeps['djScript']>['generateSegueScript']>[0][] = []
  const fishCalls: Parameters<FishService['synthesize']>[0][] = []
  const targetCalls: number[] = []
  const scriptDefers: ReturnType<typeof deferred<Record<string, unknown>>>[] = []
  const fishDefers: ReturnType<typeof deferred<Awaited<ReturnType<FishService['synthesize']>>>>[] = []
  let clock = 1700000000000
  const deps = {
    sessions: { isOpen: () => true, accept: () => ({ ok: true as const }), isCurrent: () => true },
    settings: () => ({ djVoiceReferenceId: 'voice-1', fishModel: 's2.1-pro-free' }),
    getApiKey: () => 'key-test',
    resolveTarget: async (trackId: number) => {
      targetCalls.push(trackId)
      return { kind: 'full', name: '灯塔', artists: '另一位歌手' }
    },
    djScript: {
      generateSegueScript: async (input: Parameters<NonNullable<DjPipelineDeps['djScript']>['generateSegueScript']>[0]) => {
        scriptCalls.push(input)
        const d = deferred()
        scriptDefers.push(d)
        return d.promise
      },
    },
    fish: {
      synthesize: async (input: Parameters<FishService['synthesize']>[0]) => {
        fishCalls.push(input)
        const d = deferred<Awaited<ReturnType<FishService['synthesize']>>>()
        fishDefers.push(d)
        if (over.fishAutoResolve) d.resolve!(over.fishAutoResolve === true ? FISH_OK() : over.fishAutoResolve)
        return d.promise
      },
      evaluateAudioDuration: fishMod.evaluateAudioDuration,
      validateVoiceConfig: fishMod.validateVoiceConfig,
    },
    cache: cacheMod.createAudioCache({ dir }),
    limits: { scriptMs: 5000, ttsMs: 5000, totalMs: 20000, retentionMs: 80 },
    now: () => clock,
    ...over,
  }
  return {
    deps,
    scriptCalls,
    fishCalls,
    targetCalls,
    scriptDefers,
    fishDefers,
    dir,
    tick: (ms: number) => {
      clock += ms
    },
    // 清理遵守项目规则：移入废纸篓，不自动删除
    cleanup: () => {
      moveToTrash(dir)
    },
  }
}

export const REQ = () => ({
  sessionId: 'sess-1',
  epoch: 3,
  transitionSeq: 1,
  transitionId: 'tr-1',
  fromItemId: 'itn_a',
  targetItemId: 'itn_b',
  targetTrackId: 900002,
  targetName: '灯塔',
  targetArtists: '另一位歌手',
  brief: '深夜',
})

export const SCRIPT_OK = () => {
  const s = contract.SAMPLES.sourcedScript()
  return { ok: true, script: s, meta: { searchActivity: { searchEvents: 1 } } }
}
export const AUDIO_MP3 = Buffer.alloc(50000)
export const FISH_OK = (durationMs = 20000) => ({
  ok: true as const,
  buffer: AUDIO_MP3,
  contentType: 'audio/mpeg',
  bytes: AUDIO_MP3.length,
  durationMs,
  model: 's2.1-pro-free',
})

export async function completeReady(d: Pick<ReturnType<typeof makeDeps>, 'scriptDefers' | 'fishDefers'>, req: Pick<import('@radio/contracts').PrepareRequest, 'transitionId' | 'targetItemId' | 'targetTrackId'>) {
  const s = contract.SAMPLES.sourcedScript()
  s.targetItemId = req.targetItemId
  s.transitionId = req.transitionId
  s.targetTrackId = req.targetTrackId
  d.scriptDefers[d.scriptDefers.length - 1].resolve({ ok: true, script: s, meta: {} })
  await flush()
  d.fishDefers[d.fishDefers.length - 1].resolve(FISH_OK())
  await flush()
  await flush()
}
