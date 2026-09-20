const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
require('./support/runtime.cts')
const { VoicePreviewController }: typeof import('../dist-playback/orchestration/voice-preview.js') = require('../src/orchestration/voice-preview.ts')

test('A/B 试听乱序只播 B，编辑音色使原试听成功失效', async () => {
  type Result = { ok: boolean; audio: { url: string; durationMs: number } }
  const pending = new Map<string, (result: Result) => void>()
  const played: string[] = []
  const preview = new VoicePreviewController({
    request: voice => new Promise(resolve => pending.set(voice, resolve)),
    isListening: () => false,
    play: async url => { played.push(url); return true }, cancel: () => {},
    save: async () => true,
  })
  preview.edit('A')
  const a = preview.preview()
  preview.edit('B')
  const b = preview.preview()
  pending.get('B')!({ ok: true, audio: { url: '/B', durationMs: 1000 } })
  await b
  pending.get('A')!({ ok: true, audio: { url: '/A', durationMs: 1000 } })
  await a
  assert.deepEqual(played, ['/B'])
  assert.equal(preview.getSnapshot().canSave, true)
  preview.edit('C')
  assert.equal(preview.getSnapshot().canSave, false)
  assert.equal(await preview.saveChosen(), false)
})

test('合成期间开播又停止、停止试听或离开后，旧结果均不出声', async () => {
  for (const intent of ['start-stop', 'stop', 'unmount']) {
    let resolve!: (result: { ok: boolean; audio: { url: string; durationMs: number } }) => void
    let listening = false
    const preview = new VoicePreviewController({
      request: () => new Promise(done => { resolve = done }),
      isListening: () => listening,
      play: async () => { assert.fail(`${intent} 后不应播放`); return false }, cancel: () => {}, save: async () => true,
    })
    preview.edit('fixture')
    const request = preview.preview()
    listening = intent === 'start-stop'
    preview.stop()
    listening = false
    resolve({ ok: true, audio: { url: '/stale', durationMs: 1000 } })
    await request
    assert.equal(preview.getSnapshot().canSave, false)
  }
})
