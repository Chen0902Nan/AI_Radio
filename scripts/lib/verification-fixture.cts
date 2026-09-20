/** 独立子进程的供应商替身；只替换供应商接入，HTTP/SQLite/编排仍跑生产模块。 */
import type { AddressInfo } from 'node:net'
const http: typeof import('node:http') = require('node:http')
const fs: typeof import('node:fs') = require('node:fs')
require('reflect-metadata')
const { NestFactory }: typeof import('@nestjs/core') = require('@nestjs/core')
const { AppModule }: typeof import('../../apps/api/dist/app.module.js') = require('../../apps/api/dist/app.module.js')
const { DbService }: typeof import('../../apps/api/dist/persistence/db.service.js') = require('../../apps/api/dist/persistence/db.service.js')
const { setCodexMode }: typeof import('../../apps/api/dist/codex/codex.service.js') = require('../../apps/api/dist/codex/codex.service.js')
const { setFishMode }: typeof import('../../apps/api/dist/dj/fish.service.js') = require('../../apps/api/dist/dj/fish.service.js')
const { setDjScriptMode }: typeof import('../../apps/api/dist/dj/dj-script.service.js') = require('../../apps/api/dist/dj/dj-script.service.js')

function wave(seconds: number): Buffer {
  const rate = 8000, frames = rate * seconds, buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 800), 44 + i * 2)
  return buffer
}
const duration = Number(process.env.RADIO_FIXTURE_SECONDS || 4)
const audio = wave(duration)
const media = http.createServer((req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1
  if (start > end) { res.writeHead(416); res.end(); return }
  const headers: Record<string, string | number> = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': end - start + 1 }
  if (range) headers['content-range'] = `bytes ${start}-${end}/${audio.length}`
  res.writeHead(range ? 206 : 200, headers); res.end(audio.subarray(start, end + 1))
})
const song = (id: number) => ({ id, name: `验证歌曲${id}`, ar: [{ name: '验证歌手' }], al: { name: '' }, dt: duration * 1000 })
async function fixtureSuppliers(): Promise<void> {
  await new Promise<void>(resolve => media.listen(0, '127.0.0.1', resolve))
  const mediaBase = `http://127.0.0.1:${(media.address() as AddressInfo).port}`
  // 第三方 CommonJS 模块没有声明；适配局限在此处，所有出站接口均替换为本地 fixture。
  const ncm: Record<string, unknown> = require('@neteasecloudmusicapienhanced/api')
  for (const key of Object.keys(ncm)) if (typeof ncm[key] === 'function') ncm[key] = async () => { throw new Error(`未声明的供应商 fixture: ${key}`) }
  Object.assign(ncm, {
    login_status: async () => ({ body: { data: { code: 200, profile: { userId: 1, nickname: 'Fixture', vipType: 0 } } } }),
    likelist: async () => ({ body: { code: 200, ids: Array.from({ length: 30 }, (_, i) => i + 1) } }),
    song_detail: async ({ ids }: { ids: string }) => ({ body: { code: 200, songs: String(ids).split(',').map(Number).map(song) } }),
    user_playlist: async () => ({ body: { code: 200, playlist: [{ id: 100, name: '验证歌单', userId: 1, trackCount: 30 }], more: false } }),
    playlist_detail: async () => ({ body: { code: 200, playlist: { id: 100, name: '验证歌单', trackCount: 30, trackIds: Array.from({ length: 30 }, (_, i) => ({ id: i + 1 })) } } }),
    recommend_songs: async () => ({ body: { code: 200, data: { dailySongs: Array.from({ length: 30 }, (_, i) => song(i + 101)) } } }),
    simi_song: async () => ({ body: { code: 200, songs: Array.from({ length: 30 }, (_, i) => song(i + 101)) } }),
    song_url_v1: async ({ id }: { id: number }) => ({ body: { code: 200, data: [{ id: Number(id), url: `${mediaBase}/${id}`, expi: 1200, br: 128000 }] } }),
  })
  if (!fs.existsSync(process.env.RADIO_SESSION_FILE!)) fs.writeFileSync(process.env.RADIO_SESSION_FILE!, JSON.stringify({ cookie: 'MUSIC_U=fixture-cookie', profile: { userId: 1, nickname: 'Fixture', vipType: 0 }, savedAt: new Date().toISOString() }))
  setCodexMode('success'); setDjScriptMode('success'); setFishMode('success')
}
async function main(): Promise<void> {
  if (process.env.RADIO_VERIFY_FIXTURE === '1') await fixtureSuppliers()
  const app = await NestFactory.create(AppModule, { logger: false })
  const db = app.get(DbService)
  if (process.env.RADIO_VERIFY_FIXTURE === '1' && process.env.RADIO_VERIFY_RESTART !== '1') {
    db.setSetting('djEnabled', 'false'); db.setSetting('djVoiceReferenceId', 'fixture'); db.setSetting('djIntervalTracks', '3')
  }
  await app.listen(0, '127.0.0.1')
  process.send?.({ base: await app.getUrl() })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app.close(); media.closeAllConnections(); media.close(); process.exitCode = 0; process.disconnect?.()
  }
  process.once('SIGTERM', () => void close())
  process.once('SIGINT', () => void close())
}
main().catch(error => { console.error(error); process.exit(1) })
