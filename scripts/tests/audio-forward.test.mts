import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter, once } from 'node:events'
import { createServer, get } from 'node:http'
import type { Request, Response } from 'express'
import type { NeteaseService, ResolvedTrack } from '../../apps/api/dist/music/netease.service.js'
const require = createRequire(import.meta.url)
const { MusicController }: typeof import('../../apps/api/dist/music/music.controller.js') = require('../../apps/api/dist/music/music.controller.js')
const source: ResolvedTrack = { id: 1, kind: 'full', identity: 'fixture', url: 'http://fixture.invalid/audio', br: 0, size: 0, type: 'mp3', level: null, freeTrialInfo: null, expiresAt: Date.now() + 100000, cached: false }
// HTTP seam fixtures implement only the fields used by this route; production class remains fully typed.
const music = () => new MusicController({ resolveTrack: async () => source } as unknown as NeteaseService)
const request = { headers: {} } as Request
class Sink extends EventEmitter {
  destroyed = false
  writableEnded = false
  headersSent = false
  chunks: Uint8Array[] = []
  writeHead() { this.headersSent = true }
  write(chunk: Uint8Array) { this.chunks.push(chunk); return false }
  end() { this.writableEnded = true }
  disconnect(event: 'close' | 'error' = 'close') { this.destroyed = true; this.emit(event, event === 'error' ? new Error('disconnect') : undefined) }
}
const response = (sink: Sink) => sink as unknown as Response
async function completed(work: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('forwarding did not finish')), 300) })]) }
  finally { clearTimeout(timer) }
}

test('disconnect before upstream headers aborts fetch and removes response listeners', async (t) => {
  const sink = new Sink()
  let signal: AbortSignal | null | undefined
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, opts?: RequestInit) => {
    signal = opts?.signal; started()
    return new Promise<globalThis.Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  })
  const work = music().audio(request, response(sink), '1')
  await ready; sink.disconnect()
  assert.equal(signal?.aborted, true)
  await completed(work)
  assert.equal(sink.listenerCount('close'), 0)
  assert.equal(sink.listenerCount('error'), 0)
  assert.equal(sink.writableEnded, false)
})

for (const event of ['close', 'error'] as const) test(`disconnect during drain (${event}) cancels reader and removes listeners`, async (t) => {
  const sink = new Sink()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])) }, cancel() { cancelled = true } })
  t.mock.method(globalThis, 'fetch', async () => new globalThis.Response(body))
  const work = music().audio(request, response(sink), '1')
  await new Promise(resolve => setImmediate(resolve))
  sink.disconnect(event)
  await completed(work)
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
  assert.equal(sink.listenerCount('drain'), 0)
  assert.equal(sink.listenerCount('close'), 0)
  assert.equal(sink.listenerCount('error'), 0)
})

test('real local HTTP disconnect closes upstream stream and completes forwarding', async () => {
  let markClosed!: () => void
  const upstreamClosed = new Promise<void>(resolve => { markClosed = resolve })
  const upstream = createServer((_req, res) => {
    res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-999/1000' })
    res.write(Buffer.alloc(20))
    res.on('close', markClosed)
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const address = upstream.address(); assert.ok(address && typeof address !== 'string')
  const controller = new MusicController({ resolveTrack: async () => ({ ...source, url: `http://127.0.0.1:${address.port}/audio` }) } as unknown as NeteaseService)
  let forwarding: Promise<void> | undefined
  const proxy = createServer((req, res) => { forwarding = controller.audio(req as Request, res as Response, '1') })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== 'string')
  try {
    await new Promise<void>((resolve, reject) => {
      get(`http://127.0.0.1:${proxyAddress.port}/audio`, { headers: { range: 'bytes=0-999' } }, res => {
        assert.equal(res.statusCode, 206)
        assert.equal(res.headers['content-range'], 'bytes 0-999/1000')
        res.once('data', () => { res.destroy(); resolve() })
      }).once('error', reject)
    })
    await completed(upstreamClosed)
    await completed(forwarding!)
  } finally {
    proxy.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))])
  }
})

test('disconnect while reader is pending cancels and releases the stream', async (t) => {
  const sink = new Sink()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  t.mock.method(globalThis, 'fetch', async () => new globalThis.Response(body))
  const work = music().audio(request, response(sink), '1')
  await new Promise(resolve => setImmediate(resolve))
  sink.disconnect()
  await completed(work)
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})

test('normal audio and upstream failure preserve the HTTP response contract', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: unknown, opts?: RequestInit) => {
    assert.equal(new Headers(opts?.headers).get('range'), 'bytes=0-2')
    return new globalThis.Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-length': '3', 'content-range': 'bytes 0-2/3' } })
  })
  const server = createServer((req, res) => {
    const adapted = Object.assign(res, {
      status(value: number) { res.statusCode = value; return adapted },
      header(name: string, value: string) { res.setHeader(name, value); return adapted },
    })
    void music().audio(req as Request, adapted as unknown as Response, '1')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  async function receive() {
    return new Promise<{ status?: number; headers: import('node:http').IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
      get(`http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 0}/audio`, { headers: { range: 'bytes=0-2' } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }))
      }).on('error', reject)
    })
  }
  try {
    const success = await receive()
    assert.equal(success.status, 206)
    assert.equal(success.headers['cache-control'], 'no-store')
    assert.equal(success.headers['content-range'], 'bytes 0-2/3')
    assert.deepEqual(success.bytes, Buffer.from([1, 2, 3]))
    fetchMock.mock.mockImplementation(async () => new globalThis.Response('missing', { status: 404 }))
    const missing = await receive()
    assert.equal(missing.status, 502)
    assert.equal(JSON.parse(missing.bytes.toString()).code, 'upstream_status')
    fetchMock.mock.mockImplementation(async () => { throw new Error('network failure') })
    const failure = await receive()
    assert.equal(failure.status, 502)
    assert.equal(JSON.parse(failure.bytes.toString()).code, 'upstream_error')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
