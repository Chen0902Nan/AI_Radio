/**
 * 会话、反馈、设置、播放记录控制器：路由合同见 docs/migration/route-contract.md §4。
 */
import { Controller, Get, Post, Delete, Param, Body, Res, HttpCode } from '@nestjs/common'
import type { Response } from 'express'
import { DbService } from '../persistence/db.service'
import { ListeningService } from './listening.service'
import { EventsService } from '../events/events.service'
import { DjPipelineService } from '../dj/dj-pipeline.service'
import { sendJson } from '../http/json.util'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOptionalText<T extends string>(body: Record<string, unknown>, fields: readonly T[]): body is Record<string, unknown> & Partial<Record<T, string | null>> {
  return fields.every(field => body[field] == null || typeof body[field] === 'string')
}

@Controller('api')
export class ListeningController {
  constructor(
    private readonly db: DbService,
    private readonly listening: ListeningService,
    private readonly djPipeline: DjPipelineService,
    private readonly events: EventsService,
  ) {}

  @Get('session')
  getSession(@Res() res: Response): void {
    sendJson(res, 200, {
      ok: true,
      session: this.db.getOpenSession(),
      feedback: this.db.feedbackSummary(),
    })
  }

  @Post('session/start')
  @HttpCode(200)
  startSession(@Res() res: Response): void {
    // 已开启的会话直接复用：网页刷新只是重新连上，不会新建会话或重复播放任务
    sendJson(res, 200, { ok: true, session: this.db.startSession() })
  }

  @Post('session/stop')
  @HttpCode(200)
  stopSession(@Res() res: Response): void {
    sendJson(res, 200, this.listening.stopSession())
  }

  @Post('session/adjustment')
  @HttpCode(200)
  adjustment(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    const session = this.db.getOpenSession()
    if (!session) return sendJson(res, 409, { ok: false, code: 'NO_SESSION', message: '当前没有进行中的收听会话' })
    if (!body.key) return sendJson(res, 400, { ok: false, message: '缺少 key' })
    const adjustments = this.db.setAdjustment(session.id as string, String(body.key), body.value)
    sendJson(res, 200, { ok: true, adjustments })
  }

  @Get('feedback')
  feedback(@Res() res: Response): void {
    sendJson(res, 200, {
      ok: true,
      active: this.db.listFeedback(),
      summary: this.db.feedbackSummary(),
    })
  }

  @Post('feedback')
  @HttpCode(200)
  addFeedback(@Res() res: Response, @Body() body: unknown): void {
    if (!isObject(body) || !hasOptionalText(body, ['trackName', 'artists', 'source'])) {
      return sendJson(res, 400, { ok: false, code: 'invalid_request', message: 'trackName、artists 和 source 必须是文本或 null' })
    }
    if (body.sentiment !== 'like' && body.sentiment !== 'dislike') {
      return sendJson(res, 400, { ok: false, code: 'invalid_request', message: 'sentiment 必须是 like 或 dislike' })
    }
    const trackId = Number(body.trackId)
    if (!Number.isSafeInteger(trackId) || trackId <= 0) return sendJson(res, 400, { ok: false, message: '缺少 trackId' })
    try {
      const session = this.db.getOpenSession()
      const row = this.db.addFeedback({
        trackId,
        trackName: body.trackName,
        artists: body.artists,
        sentiment: body.sentiment,
        source: body.source || 'ui',
        sessionId: session ? (session.id as string) : null,
      })
      sendJson(res, 200, { ok: true, feedback: row, summary: this.db.feedbackSummary() })
    } catch (err) {
      sendJson(res, 400, { ok: false, message: (err as Error).message })
    }
  }

  @Delete('feedback/:trackId')
  revokeFeedback(@Res() res: Response, @Param('trackId') trackId: string): void {
    const r = this.db.revokeFeedback(Number(trackId))
    sendJson(res, 200, { ok: true, ...r, summary: this.db.feedbackSummary() })
  }

  @Get('settings')
  getSettings(@Res() res: Response): void {
    sendJson(res, 200, { ok: true, settings: this.db.listSettings(), djVoice: this.djPipeline.configuration() })
  }

  @Post('settings')
  @HttpCode(200)
  setSettings(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    if (!body.key) return sendJson(res, 400, { ok: false, message: '缺少 key' })
    const saved = this.db.setSetting(String(body.key), body.value)
    // 语音相关配置更新后解除流水线的配置/认证阻塞
    this.djPipeline.voiceConfigChanged()
    this.events.publish({ type: 'config-changed', sessionId: (this.db.getOpenSession() as { id?: string })?.id ?? null, key: String(body.key) })
    sendJson(res, 200, {
      ok: true,
      setting: saved,
      settings: this.db.listSettings(),
      djVoice: this.djPipeline.configuration(),
    })
  }

  @Get('plays/history')
  playHistory(@Res() res: Response): void {
    sendJson(res, 200, { ok: true, automatic: this.db.automaticHistory(), recent: this.db.recentPlays() })
  }

  @Post('plays/start')
  @HttpCode(200)
  playStart(@Res() res: Response, @Body() body: unknown): void {
    if (!isObject(body) || !hasOptionalText(body, ['trackName', 'artists', 'sessionId', 'selectionId', 'playInstanceId'])) {
      return sendJson(res, 400, { ok: false, code: 'invalid_request', message: '播放名称和标识字段必须是文本或 null' })
    }
    const trackId = Number(body.trackId)
    if (!Number.isSafeInteger(trackId) || trackId <= 0) return sendJson(res, 400, { ok: false, message: '缺少 trackId' })
    if (body.sessionId && !this.db.getSession(String(body.sessionId))) return sendJson(res, 409, { ok: false, code: 'session_ended' })
    if (body.sessionId && this.db.getSession(String(body.sessionId))?.ended_at) return sendJson(res, 409, { ok: false, code: 'session_ended' })
    // 没有会话时按规格自动建立，避免播放记录脱离会话
    const session = this.db.getOpenSession() || this.db.startSession()
    const playId = this.db.recordPlay({
      sessionId: session.id as string,
      trackId,
      selectionId: typeof body.selectionId === 'string' ? body.selectionId : null,
      playInstanceId: typeof body.playInstanceId === 'string' ? body.playInstanceId.slice(0, 200) : null,
      trackName: body.trackName,
      artists: body.artists,
    })
    sendJson(res, 200, { ok: true, playId, session })
  }

  @Post('plays/end')
  @HttpCode(200)
  playEnd(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    this.db.finishPlay(Number(body.playId), String(body.outcome || 'unknown'))
    sendJson(res, 200, { ok: true })
  }
}
