import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const api: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = require('@neteasecloudmusicapienhanced/api')
const { NeteaseService }: typeof import('../../apps/api/dist/music/netease.service.js') = require('../../apps/api/dist/music/netease.service.js')
const song = { id: 1, name: 'Song', ar: [{ name: 'Singer' }], al: { name: 'Album' }, dt: 120000 }
const goodSource = { url: 'https://example.com/song.mp3', expi: 1200, br: 320000, size: 1234, type: 'mp3', level: 'exhigh', freeTrialInfo: null }
function fixture() {
  const service = new NeteaseService()
  service.loadSession = () => ({ cookie: 'MUSIC_U=fixture', savedAt: 'now', profile: { userId: 1 } })
  return service
}
for (const patch of [{ url: 42 }, { url: 'file:///tmp/audio' }, { expi: Infinity }, { expi: 'oops' }, { br: NaN }, { freeTrialInfo: [] }]) {
  test(`reject malformed playable source ${JSON.stringify(patch)}`, async (t) => {
    t.mock.method(api, 'song_url_v1', async () => ({ body: { code: 200, data: [{ ...goodSource, ...patch }] } }))
    await assert.rejects(fixture().resolveTrack(1), /无效|invalid/i)
  })
}
for (const patch of [{ ar: {} }, { name: undefined }, { dt: Infinity }, { id: '1' }]) {
  test(`reject malformed track ${JSON.stringify(patch)}`, async (t) => {
    t.mock.method(api, 'song_detail', async () => ({ body: { code: 200, songs: [{ ...song, ...patch }] } }))
    await assert.rejects(fixture().getLikedTracks('fixture', [1]), /无效|invalid/i)
  })
}
test('valid source and track retain numeric fields', async (t) => {
  t.mock.method(api, 'song_url_v1', async () => ({ body: { code: 200, data: [goodSource] } }))
  t.mock.method(api, 'song_detail', async () => ({ body: { code: 200, songs: [song] } }))
  const service = fixture()
  assert.equal((await service.resolveTrack(1)).kind, 'full')
  assert.deepEqual((await service.getLikedTracks('fixture', [1]))[0], { id: 1, name: 'Song', artists: 'Singer', album: 'Album', durationMs: 120000, fee: undefined, mvId: 0 })
})
test('invalid playlist identifiers cannot establish a complete library', async (t) => {
  t.mock.method(api, 'likelist', async () => ({ body: { code: 200, ids: [] } }))
  t.mock.method(api, 'user_playlist', async () => ({ body: { code: 200, playlist: [{ id: 'bad', userId: 1, name: 'Broken', trackCount: 0 }], more: false } }))
  t.mock.method(api, 'playlist_detail', async () => ({ body: { code: 200, playlist: { trackCount: 0, trackIds: [] } } }))
  t.mock.method(api, 'playlist_track_all', async () => ({ body: { code: 200, songs: [] } }))
  assert.equal((await fixture().selectionLibrary()).complete, false)
})
test('malformed playlist song container is rejected instead of complete empty data', async (t) => {
  t.mock.method(api, 'playlist_detail', async () => ({ body: { code: 200, playlist: { trackCount: 0, trackIds: [] } } }))
  t.mock.method(api, 'playlist_track_all', async () => ({ body: { code: 200, songs: {} } }))
  await assert.rejects(fixture().getPlaylistTracks('fixture', 1), /无效|invalid/i)
})

test('login status uses the upstream nested data envelope and validates profile fields', async (t) => {
  t.mock.method(api, 'login_status', async () => ({ body: { data: { code: 200, profile: { userId: 1, nickname: 'User', vipType: 0 } } } }))
  assert.deepEqual(await fixture().whoami(), { userId: 1, nickname: 'User', vipType: 0, savedAt: 'now' })
})

test('expired complete library cannot prove discovery membership after a partial refresh', async (t) => {
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(api, 'likelist', async () => ({ body: { code: 200, ids: [1] } }))
  const details = t.mock.method(api, 'song_detail', async () => ({ body: { code: 200, songs: [song] } }))
  t.mock.method(api, 'user_playlist', async () => ({ body: { code: 200, playlist: [], more: false } }))
  const service = fixture()
  assert.equal((await service.selectionLibrary()).complete, true)
  now += 300001
  details.mock.mockImplementation(async () => { throw new Error('partial upstream outage') })
  const refreshed = await service.selectionLibrary()
  assert.equal(refreshed.complete, false)
  assert.deepEqual(refreshed.tracks.map(track => track.id), [1])
})
