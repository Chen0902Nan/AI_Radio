import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { moveToTrash } from '../lib/trash.mts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-refill-dj-epoch-'))
process.env.RADIO_DB_FILE = path.join(dir, 'radio.db')
process.env.RADIO_SESSION_FILE = path.join(dir, 'session.json')
process.env.DJ_AUDIO_CACHE_DIR = path.join(dir, 'audio')
const require = createRequire(import.meta.url)
require('reflect-metadata')
const { DbService }: typeof import('../../apps/api/dist/persistence/db.service.js') = require('../../apps/api/dist/persistence/db.service.js')
const { OrchestratorService }: typeof import('../../apps/api/dist/preparation/orchestrator.service.js') = require('../../apps/api/dist/preparation/orchestrator.service.js')
const { NeteaseService }: typeof import('../../apps/api/dist/music/netease.service.js') = require('../../apps/api/dist/music/netease.service.js')
const { CodexService }: typeof import('../../apps/api/dist/codex/codex.service.js') = require('../../apps/api/dist/codex/codex.service.js')
const { EventsService }: typeof import('../../apps/api/dist/events/events.service.js') = require('../../apps/api/dist/events/events.service.js')
const db = new DbService()
test.after(() => { moveToTrash(dir) })

function gate() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const resumed = new Promise<void>(resolve => { release = resolve })
  return { entered, release, wait: async () => { enter(); await resumed } }
}

type Stage = 'discovery' | 'codex' | 'audio'
function fixture(stage: Stage) {
  const blocked = gate()
  const calls: Stage[] = []
  const ncm = new NeteaseService()
  const codex = new CodexService()
  const track = { id: 101, name: 'Fixture song', artists: 'Fixture artist', album: 'Fixture album', durationMs: 10000 }
  const boundary = async (name: Stage) => { calls.push(name); if (name === stage) await blocked.wait() }
  // Only external provider adapters are controlled; selection and persistence are real.
  ncm.currentIdentity = () => 'fixture-account'
  ncm.discoveryCandidates = async () => { await boundary('discovery'); return { tracks: [] } }
  codex.pickTracks = async () => { await boundary('codex'); return { ok: true, picks: [{ ...track, reason: 'Fixture selection' }] } }
  ncm.resolveTrack = async id => {
    await boundary('audio')
    return { id: Number(id), kind: 'full', identity: 'fixture-account', url: '/fixture.wav', br: 128000,
      size: 1000, type: 'wav', level: 'standard', freeTrialInfo: null, expiresAt: Date.now() + 60000, cached: false }
  }
  const service = new OrchestratorService(ncm, codex, db, new EventsService())
  db.endSession()
  const sessionId = db.startSession().id
  assert.equal(typeof sessionId, 'string')
  assert.ok(typeof sessionId === 'string')
  return { blocked, calls, service, sessionId, track }
}

test('DJ advances the durable epoch during Codex selection: old refill is superseded before audio work', async () => {
  const f = fixture('codex')
  const pending = f.service.prepareBatch({ sessionId: f.sessionId, epoch: 7, library: [f.track], libraryComplete: true, count: 1 })
  await f.blocked.entered
  assert.deepEqual(db.acceptDjRequest({ sessionId: f.sessionId, epoch: 8, transitionSeq: 0,
    transitionId: 'next', fromItemId: 'from', targetItemId: 'to', targetTrackId: 101 }), { ok: true })
  f.blocked.release()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'superseded')
  assert.equal('picks' in result, false)
  assert.deepEqual(f.calls, ['discovery', 'codex'])
})

for (const stage of ['discovery', 'audio'] as const) {
  test(`DJ advances the epoch during ${stage}: no old batch or later provider work is delivered`, async () => {
    const f = fixture(stage)
    const pending = f.service.prepareBatch({ sessionId: f.sessionId, epoch: 7,
      library: [f.track, { ...f.track, id: 102 }], libraryComplete: true, count: 2 })
    await f.blocked.entered
    assert.deepEqual(db.acceptDjRequest({ sessionId: f.sessionId, epoch: 8, transitionSeq: 0,
      transitionId: 'next', fromItemId: 'from', targetItemId: 'to', targetTrackId: 101 }), { ok: true })
    f.blocked.release()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, 'superseded')
    assert.equal('picks' in result, false)
    assert.deepEqual(f.calls, stage === 'discovery' ? ['discovery'] : ['discovery', 'codex', 'audio'])
  })
}

for (const stage of ['discovery', 'codex', 'audio'] as const) {
  test(`a later DJ transition in the same epoch during ${stage} preserves the refill`, async () => {
    const f = fixture(stage)
    const first = { sessionId: f.sessionId, epoch: 7, transitionSeq: 0,
      transitionId: 'first', fromItemId: 'from', targetItemId: 'to', targetTrackId: 101 }
    assert.deepEqual(db.acceptDjRequest(first), { ok: true })
    const pending = f.service.prepareBatch({ sessionId: f.sessionId, epoch: 7, library: [f.track], libraryComplete: true, count: 1 })
    await f.blocked.entered
    assert.deepEqual(db.acceptDjRequest({ ...first, transitionSeq: 1, transitionId: 'second' }), { ok: true })
    f.blocked.release()
    const result = await pending
    assert.equal(result.ok, true)
    assert.ok(Array.isArray(result.picks))
    assert.equal(result.picks.length, 1)
    assert.deepEqual(f.calls, ['discovery', 'codex', 'audio'])
  })
}
