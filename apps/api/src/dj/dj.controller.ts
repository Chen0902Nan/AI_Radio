/**
 * DJ 串场控制器：路由合同见 docs/migration/route-contract.md §5。
 * 状态码映射与旧服务一致；音频直接文件流，Range/206/416 语义保持。
 */
import { Controller, Post, Get, All, Param, Body, Req, Res, HttpCode } from '@nestjs/common'
import type { Request, Response } from 'express'
import * as fs from 'node:fs'
import { DjPipelineService } from './dj-pipeline.service'
import { DbService } from '../persistence/db.service'
import { sendJson } from '../http/json.util'

@Controller('api/dj')
export class DjController {
  constructor(
    private readonly djPipeline: DjPipelineService,
    private readonly db: DbService,
  ) {}

  @Post('prepare')
  @HttpCode(200)
  async prepare(@Res() res: Response, @Body() body: Record<string, unknown>): Promise<void> {
    const r = (await this.djPipeline.prepare(body)) as { ok: boolean; code?: string }
    if (!r.ok) {
      const status = prepareStatus(r.code)
      sendJson(res, status, r)
      return
    }
    sendJson(res, 200, r)
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  async cancel(@Res() res: Response, @Param('id') id: string): Promise<void> {
    const r = await this.djPipeline.cancel(id)
    sendJson(res, 200, r)
  }

  @Get('jobs/:id')
  job(@Res() res: Response, @Param('id') id: string): void {
    const r = this.djPipeline.job(id)
    if (!r.ok) return sendJson(res, 404, r)
    sendJson(res, 200, r)
  }

  @All('audio/:assetId')
  audio(@Req() req: Request, @Res() res: Response, @Param('assetId') assetId: string): void {
    const filePath = this.djPipeline.assetPath(assetId)
    if (!filePath) {
      sendJson(res, 404, { code: 'asset_not_found', message: '音频不存在或已过期' })
      return
    }
    const stat = fs.statSync(filePath)
    const total = stat.size
    const base = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
    const range = req.headers.range
    if (range) {
      const m = String(range).match(/bytes=(\d*)-(\d*)/)
      const start = m && m[1] ? Number(m[1]) : 0
      const end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1
      if (!Number.isFinite(start) || start > end || start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}` })
        res.end()
        return
      }
      res.writeHead(206, {
        ...base,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': end - start + 1,
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { ...base, 'content-length': total })
    fs.createReadStream(filePath).pipe(res)
  }

  @Post('preview')
  @HttpCode(200)
  async preview(@Res() res: Response, @Body() body: Record<string, unknown>): Promise<void> {
    // 仅在停止收听时允许试听，避免打断节目（契约第 6 节）
    if (this.db.getOpenSession()) {
      sendJson(res, 409, { ok: false, code: 'session_active', message: '停止收听后才能试听音色' })
      return
    }
    const r = (await this.djPipeline.preview({
      referenceId: typeof body.referenceId === 'string' ? body.referenceId.trim() : '',
    })) as { ok: boolean; code?: string }
    if (!r.ok) {
      const status = r.code === 'not_configured' ? 409 : r.code === 'auth' ? 401 : r.code === 'rate_limited' ? 429 : 502
      sendJson(res, status, r)
      return
    }
    sendJson(res, 200, r)
  }
}

function prepareStatus(code: string | undefined): number {
  if (code === 'invalid_request') return 400
  if (['payload_conflict', 'session_ended', 'stale_epoch'].includes(code || '')) return 409
  if (code === 'cooldown_active' || code?.endsWith('_blocked')) return 429
  return 502
}
