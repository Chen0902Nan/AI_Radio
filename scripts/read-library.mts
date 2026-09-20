import type { ProbeReport } from './lib/tool-types.d.ts'
import type { LibraryReport } from './lib/library-checks.mts'
type LibraryProbeReport = ProbeReport & LibraryReport & { steps: NonNullable<LibraryReport["steps"]>; failures: string[]; playlists?: Record<string, unknown> }
/**
 * 读取真实账号音乐资料（只读），检查分页、去重与错误处理，并输出不含凭据的报告。
 * 用法：node scripts/read-library.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { collectFailures } from './lib/library-checks.mts'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 迁移后使用 Nest 编译产物的 NeteaseService（原 server/netease.js）
const { NeteaseService }: typeof import('../apps/api/dist/music/netease.service.js') = require('../apps/api/dist/music/netease.service.js')
const ncm = new NeteaseService()
const OUT_DIR = process.env.RADIO_REPORT_OUT
  ? path.resolve(process.env.RADIO_REPORT_OUT)
  : path.resolve(__dirname, '..', '.scratch/radio-agent/verification/artifacts')
fs.mkdirSync(OUT_DIR, { recursive: true })

const redact = (s: unknown) => String(s).replace(/MUSIC_U=[^;]+/g, 'MUSIC_U=***')

function sample(list: import('../apps/api/dist/music/netease.service.js').Track[], n = 5) {
  return list.slice(0, n).map((t) => ({
    id: t.id,
    name: t.name,
    artists: t.artists,
    album: t.album,
    durationMs: t.durationMs,
    fee: t.fee,
  }))
}

async function main() {
  const report: LibraryProbeReport = { at: new Date().toISOString(), steps: [], failures: [] }
  const session = ncm.loadSession()
  if (!session) {
    report.blocked = '未登录：data/session.json 不存在，请先扫码登录'
    report.failures = collectFailures(report)
    report.ok = false
    writeReport(report)
    console.error(JSON.stringify(report, null, 2))
    process.exitCode = 2
    return
  }

  await ncm.init()

  const account = session.profile || {}
  const uid = Number(account.userId)
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('登录态缺少有效用户ID')
  report.account = { userId: uid, nickname: account.nickname }
  report.steps.push({ step: 'session', ok: true, uid, nickname: account.nickname })

  // 1. 红心歌曲
  const likedIds = await ncm.getLikedIds(session.cookie)
  const likedUnique = new Set(likedIds)
  const likedTracks = await ncm.getLikedTracks(session.cookie, likedIds)
  const likedTrackIds = likedTracks.map((t) => t.id)
  report.liked = {
    idsReturned: likedIds.length,
    idsUnique: likedUnique.size,
    duplicatesInIds: likedIds.length - likedUnique.size,
    tracksReturned: likedTracks.length,
    missingDetails: likedIds.length - likedTracks.length,
    totalDurationMs: likedTracks.reduce((a, t) => a + (t.durationMs || 0), 0),
    samples: sample(likedTracks, 5),
  }
  report.steps.push({ step: 'liked', ok: true, count: likedTracks.length })

  // 2. 收藏 / 自建歌单（分页）
  const playlists = await ncm.getUserPlaylists(session.cookie, uid)
  const plIds = [...playlists.created, ...playlists.collected].map((p) => p.id)
  report.playlists = {
    created: playlists.created.length,
    collected: playlists.collected.length,
    total: playlists.total,
    duplicateIds: plIds.length - new Set(plIds).size,
    pages: playlists.pages,
    samples: [...playlists.created, ...playlists.collected].slice(0, 6).map((p) => ({
      id: p.id,
      name: p.name,
      trackCount: p.trackCount,
      kind: p.subscribed ? 'collected' : 'created',
    })),
  }
  report.steps.push({ step: 'playlists', ok: true, ...report.playlists, samples: undefined })

  // 2b. 分页：小 pageSize 强制多页，结果必须与单页一致（验证不会漏也不会重复）
  const pageChecks = []
  for (const ps of [2, 4, 50]) {
    const r = await ncm.getUserPlaylists(session.cookie, uid, { pageSize: ps })
    pageChecks.push({
      pageSize: ps,
      pageCount: r.pages.length,
      pages: r.pages,
      total: r.total,
      ids: [...r.created, ...r.collected].map((p) => p.id),
    })
  }
  const baseline = JSON.stringify([...pageChecks[pageChecks.length - 1].ids].sort())
  report.pagination = {
    checks: pageChecks.map((c) => ({ pageSize: c.pageSize, pageCount: c.pageCount, pages: c.pages, total: c.total })),
    consistent: pageChecks.every((c) => JSON.stringify([...c.ids].sort()) === baseline),
    endpointBehavior:
      '/api/user/playlist 实测忽略 limit、认识 offset，且 more 恒为 false；翻页改为按实际返回条数推进 offset + 去重',
    note: '红心歌曲用 /api/song/like/get 一次返回全部 id，无服务端分页；歌曲详情按 300 分块',
  }
  report.steps.push({ step: 'pagination', ok: report.pagination.consistent })

  // 3. 抽取若干歌单验证曲目分页与去重
  report.playlistTracks = []
  const targets = [...playlists.created, ...playlists.collected].slice(0, 8)
  for (const pl of targets) {
    try {
      const r = await ncm.getPlaylistTracks(session.cookie, pl.id)
      const ids = r.tracks.map((t) => t.id)
      report.playlistTracks.push({
        id: pl.id,
        name: pl.name,
        declaredTrackCount: r.trackCount,
        returned: r.returned,
        unique: new Set(ids).size,
        via: r.via,
        complete: r.trackCount ? r.returned === r.trackCount : null,
        sample: sample(r.tracks, 2),
      })
    } catch (err) {
      report.playlistTracks.push({ id: pl.id, name: pl.name, error: redact((err instanceof Error ? err.message : String(err))) })
      report.steps.push({ step: 'playlistTracks', ok: false, id: pl.id, error: redact((err instanceof Error ? err.message : String(err))) })
    }
  }

  // 4. 错误处理检查：故意用不存在的歌曲 id
  try {
    const bogus = await ncm.resolveTrack(999999999999)
    report.errorHandling = {
      bogusId: 999999999999,
      kind: bogus.kind,
      note: '不存在的 id 未抛错但被分类为不可播放',
    }
  } catch (err) {
    report.errorHandling = { bogusId: 999999999999, threw: redact((err instanceof Error ? err.message : String(err))), note: '按预期抛错' }
  }

  // 5. 权限分布抽样（不输出任何播放地址）
  const probe = likedTracks.slice(0, 12)
  const dist: Record<string, number> = { full: 0, trial: 0, none: 0, error: 0 }
  const details = []
  for (const t of probe) {
    try {
      const info = await ncm.resolveTrack(t.id)
      dist[info.kind] += 1
      details.push({
        id: t.id,
        name: t.name,
        kind: info.kind,
        fee: info.fee,
        br: info.br,
        sizeMB: info.size ? +(info.size / 1048576).toFixed(2) : 0,
        durationMs: t.durationMs,
        level: info.level,
      })
    } catch (err) {
      dist.error += 1
      details.push({ id: t.id, name: t.name, error: redact((err instanceof Error ? err.message : String(err))) })
    }
  }
  report.playability = { sampled: probe.length, distribution: dist, details }
  report.steps.push({ step: 'playability', ok: dist.error === 0, error: dist.error ? `音源查询报错 ${dist.error} 首` : undefined })

  finish(report)
}

/** 统一收口：把判定结果写进报告，并用退出码表达失败。 */
function finish(report: LibraryProbeReport) {
  report.failures = collectFailures(report)
  report.ok = report.failures.length === 0
  writeReport(report)
  console.log(
    JSON.stringify(
      { ...report, liked: report.liked ? { ...report.liked, samples: report.liked.samples } : report.liked },
      null,
      2,
    ),
  )
  if (!report.ok) {
    console.error('\n资料读取未通过：')
    for (const f of report.failures) console.error('  - ' + f)
    process.exitCode = 1
  } else {
    console.log('\n资料读取检查全部通过。')
  }
}

function writeReport(report: ProbeReport) {
  fs.writeFileSync(
    path.join(OUT_DIR, 'library-read.json'),
    JSON.stringify(report, null, 2),
    'utf-8',
  )
}

main().catch((err) => {
  console.error('读取失败：', redact(err.stack || (err instanceof Error ? err.message : String(err))))
  process.exitCode = 1
})
