import type { Request, Response } from 'express'
import { sendJson } from '../http/json.util'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']

function waitForDrain(res: Response, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      res.off('drain', finish)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    res.once('drain', finish)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

function copyHeaders(upstream: globalThis.Response, res: Response): void {
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  res.writeHead(upstream.status, headers)
}

async function copyBody(reader: ReadableStreamDefaultReader<Uint8Array>, res: Response, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done || signal.aborted) return
    if (!res.write(Buffer.from(value))) await waitForDrain(res, signal)
  }
}

function forwardFailure(error: unknown, res: Response, signal: AbortSignal): void {
  if (signal.aborted || res.destroyed) return
  if (res.headersSent) res.destroy(error instanceof Error ? error : undefined)
  else sendJson(res, 502, { code: 'upstream_error', message: error instanceof Error ? error.message : String(error) })
}

/** Own the fetch, reader and response listeners for exactly one forwarding operation. */
export async function forwardAudio(req: Request, res: Response, url: string): Promise<void> {
  if (res.destroyed || res.writableEnded) return
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const disconnect = () => {
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
  res.on('close', disconnect)
  res.on('error', disconnect)
  try {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT }
    if (req.headers.range) headers.range = req.headers.range
    const upstream = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
    reader = upstream.body?.getReader()
    if (controller.signal.aborted) return
    if (!upstream.ok && upstream.status !== 206) {
      sendJson(res, 502, { code: 'upstream_status', status: upstream.status, message: `音源 CDN 返回 ${upstream.status}` })
      return
    }
    copyHeaders(upstream, res)
    if (reader) await copyBody(reader, res, controller.signal)
    if (!controller.signal.aborted) res.end()
  } catch (error) {
    forwardFailure(error, res, controller.signal)
  } finally {
    controller.abort()
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
    res.off('close', disconnect)
    res.off('error', disconnect)
  }
}
