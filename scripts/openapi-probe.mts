/**
 * 官方开放平台接口的只读探针。
 *
 * 目的：用真实 appId/privateKey 验证个人应用能不能调通官方接口，特别是取音源。
 * 只做只读调用，不写任何数据；不打印 accessToken 与播放直链。
 *
 * 签名规则（来自官方「厂商接入指南 > 应用签名」）：
 *   1. 取所有请求参数，剔除 sign 与空值
 *   2. 按 key 的 ASCII 升序排序
 *   3. 拼成 k1=v1&k2=v2…
 *   4. 用应用私钥做 SHA256withRSA 签名，结果 base64 作为 sign
 * 注意待签串里没有 appSecret，只要 appId + privateKey。
 *
 * 用法：node scripts/openapi-probe.mts [--song=65536]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CRED_FILE = process.env.OPENAPI_CRED_FILE || path.join(ROOT, 'data/openapi-cred.json')
const BASE = 'https://openapi.music.163.com'

const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'))
const privateKey = crypto.createPrivateKey({
  key: Buffer.from(cred.privateKey, 'base64'),
  format: 'der',
  type: 'pkcs8',
})

// channel / deviceType / os 文档写明“由云音乐分配，需线下联系云音乐同事确认”。
// 这里借用本机 ncm-cli 实际发送的通道参数做可行性探测；
// 若真要长期接入，需要云音乐给我们自己的应用分配一套通道值。
const DEVICE = {
  deviceType: 'openapi',
  os: 'ncmcli',
  appVer: '0.1.7',
  channel: 'ncmcli',
  model: 'Mac_arm64_cli',
  brand: 'ncmcli',
  osVer: '15.3',
  clientIp: process.env.PROBE_CLIENT_IP || '0.0.0.0',
  deviceId: 'ai-radio-probe-0001',
}

async function resolvePublicIp() {
  if (process.env.PROBE_CLIENT_IP) return process.env.PROBE_CLIENT_IP
  try {
    const res = await fetch('https://api.music.163.com/jsonip', { headers: { 'user-agent': 'curl/8' } })
    const text = await res.text()
    const m = text.match(/\d+\.\d+\.\d+\.\d+/)
    if (m) return m[0]
  } catch (_) {}
  try {
    const res = await fetch('https://api.ipify.org')
    const t = (await res.text()).trim()
    if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) return t
  } catch (_) {}
  return '0.0.0.0'
}

function sign(params: { [s: string]: unknown }|ArrayLike<unknown>) {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (k === 'sign' || v === undefined || v === null || v === '') continue
    clean[k] = String(v)
  }
  const content = Object.keys(clean)
    .sort()
    .map((k) => `${k}=${clean[k]}`)
    .join('&')
  const signature = crypto.sign('RSA-SHA256', Buffer.from(content, 'utf-8'), privateKey)
  return { signed: { ...clean, sign: signature.toString('base64') }, content }
}

async function callOpenApi(pathname: string, bizContent: Record<string, unknown>, { accessToken = null, method = 'POST' }: { accessToken?: string | null; method?: 'POST' | 'GET' } = {}) {
  const params: Record<string, string> = {
    appId: cred.appId,
    bizContent: JSON.stringify(bizContent),
    device: JSON.stringify(DEVICE),
    signType: 'RSA_SHA256',
    timestamp: String(Date.now()),
  }
  if (accessToken) params.accessToken = accessToken
  const { signed, content } = sign(params)

  const body = new URLSearchParams(signed).toString()
  const url = method === 'GET' ? `${BASE}${pathname}?${body}` : `${BASE}${pathname}`
  const started = Date.now()
  const res = await fetch(url, {
    method,
    headers:
      method === 'POST'
        ? { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }
        : undefined,
    body: method === 'POST' ? body : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_) {}
  return {
    httpStatus: res.status,
    ms: Date.now() - started,
    json,
    raw: json ? null : text.slice(0, 400),
    signedFieldCount: Object.keys(signed).length,
    contentPreview: content.replace(/accessToken=[^&]*/, 'accessToken=<REDACTED>').slice(0, 300),
  }
}

function summarize(label: string, r: { httpStatus: any; ms: any; json: any; raw: any; signedFieldCount?: number; contentPreview?: string }) {
  const body = r.json || {}
  console.log(`\n### ${label}`)
  console.log(`  HTTP ${r.httpStatus} · ${r.ms}ms`)
  console.log(`  code=${body.code} subCode=${body.subCode} message=${JSON.stringify(body.message)}`)
  if (body.data) {
    const d = body.data
    if (Array.isArray(d)) {
      console.log(`  data: 数组 ${d.length} 项`)
      for (const item of d.slice(0, 5)) {
        console.log('   ', JSON.stringify(maskItem(item)))
      }
    } else {
      console.log('  data:', JSON.stringify(maskItem(d)).slice(0, 500))
    }
  }
  if (r.raw) console.log('  raw:', r.raw)
  return body
}

function maskItem(item: { [s: string]: unknown }|ArrayLike<unknown>) {
  if (!item || typeof item !== 'object') return item
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) {
    if (/token/i.test(k)) out[k] = '<REDACTED>'
    else if (k === 'url') out[k] = v ? `<有地址，长度 ${String(v).length}，host=${safeHost(String(v))}>` : null
    else if (typeof v === 'object' && v !== null) out[k] = Array.isArray(v) ? `[${v.length}]` : '{…}'
    else out[k] = v
  }
  return out
}

function safeHost(u: string|URL) {
  try {
    return new URL(u).host
  } catch (_) {
    return '?'
  }
}

async function main() {
  const songArg = process.argv.find((a) => a.startsWith('--song='))
  const songId = songArg ? songArg.split('=')[1] : '65536'

  console.log(`appId 前缀 ${cred.appId.slice(0, 4)}…（共 ${cred.appId.length} 位）`)
  DEVICE.clientIp = await resolvePublicIp()
  console.log(`clientIp: ${DEVICE.clientIp}`)

  const anon = await callOpenApi('/openapi/music/basic/oauth2/login/anonymous', {
    clientId: cred.appId,
  })
  const anonBody = summarize('1. 匿名登录 /oauth2/login/anonymous', anon)
  const accessToken = anonBody.data && anonBody.data.accessToken
  console.log(`  accessToken: ${accessToken ? '已取得（长度 ' + accessToken.length + '，不回显）' : '未取得'}`)
  if (!accessToken) {
    console.log('\n匿名登录未拿到 accessToken，后续接口无法继续。')
    return
  }

  // 能力矩阵：同一张匿名令牌下一个接口一个接口问，区分“应用未授权”与“用户未授权”
  const matrix: Array<[string, string, Record<string, unknown>]> = [
    ['查询歌曲（搜索）', '/openapi/music/basic/search/song/get/v3', { keyword: '陈奕迅', limit: 3, offset: 0 }],
    ['获取热搜榜', '/openapi/music/basic/search/charts/list/get', {}],
    ['获取歌单详情', '/openapi/music/basic/playlist/detail/get/v2', { playlistId: songId }],
    ['批量获取歌曲信息', '/openapi/music/basic/song/list/get/v2', { songIdList: songId }],
    ['获取歌曲详情', '/openapi/music/basic/song/detail/get/v2', { songIdList: songId, withUrl: true }],
    ['获取用户基本信息', '/openapi/music/basic/user/profile/get/v2', {}],
    ['获取歌曲播放url', '/openapi/music/basic/song/playurl/get/v2', { songId, bitrate: 320 }],
    ['批量获取歌曲播放url', '/openapi/music/basic/batch/song/playurl/get', { songIdList: [songId], bitrate: 320 }],
  ]

  console.log('\n### 2. 接口能力矩阵（同一张匿名令牌）')
  console.log('  接口'.padEnd(26) + 'code\tmessage')
  const rows = []
  for (const [label, path, biz] of matrix) {
    const r = await callOpenApi(path, biz, { accessToken })
    const body = r.json || {}
    rows.push({ label, path, code: body.code, message: body.message, subCode: body.subCode })
    console.log(`  ${label.padEnd(24)} ${String(body.code).padEnd(5)} ${body.message || ''}`)
  }
  reportMatrix(rows)
}

function reportMatrix(rows: Array<{ label: string; path: string; code: unknown; message: unknown; subCode: unknown }>) {
  const outDir = path.join(ROOT, '.scratch/radio-agent/verification/artifacts')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, 'openapi-probe.json'),
    JSON.stringify({ at: new Date().toISOString(), appIdPrefix: cred.appId.slice(0, 4), rows }, null, 2),
  )
  console.log('\n矩阵已写入 artifacts/openapi-probe.json')
}

main().catch((err) => {
  console.error('探针失败：', (err instanceof Error ? err.message : String(err)))
  process.exitCode = 1
})
