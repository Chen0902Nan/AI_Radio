/**
 * 选歌与补歌控制器：路由合同见 docs/migration/route-contract.md §3。
 * 旧路由没有严格方法限制的行为不复制到带方法判断的路由（POST only 保持 POST only）。
 */
import { Controller, Post, Res, Body, HttpCode } from '@nestjs/common'
import type { Response } from 'express'
import { NeteaseService } from '../music/netease.service'
import { OrchestratorService } from './orchestrator.service'
import { DbService } from '../persistence/db.service'
import { sendJson } from '../http/json.util'
import { takeRefillError, forcedRefill } from '../test-support/refill-response'
import { preparationInput, preparationStatus } from './preparation-http'

@Controller('api')
export class PreparationController {
  constructor(
    private readonly ncm: NeteaseService,
    private readonly orchestrator: OrchestratorService,
    private readonly db: DbService,
  ) {}

  @Post('plan')
  @HttpCode(200)
  async plan(@Res() res: Response, @Body() body: Record<string, unknown>): Promise<void> {
    const session = this.ncm.loadSession()
    if (!session) return sendJson(res, 401, { ok: false, code: 'NOT_LOGGED_IN', message: '未登录' })

    const listening = this.db.getOpenSession() || this.db.startSession()
    return this.refill(res, {...body, sessionId: listening.id})
  }

  @Post('queue/refill')
  @HttpCode(200)
  async refill(@Res() res: Response, @Body() body: Record<string, unknown>): Promise<void> {
    const forced = takeRefillError()
    if (forced) return sendJson(res, preparationStatus(forced.code), forced)
    const session = this.ncm.loadSession()
    if (!session) return sendJson(res, 401, { ok: false, code: 'NOT_LOGGED_IN', message: '未登录' })

    let library
    let snapshot
    try {
      snapshot = await this.ncm.selectionLibrary()
      library = snapshot.tracks
    } catch (err) {
      sendJson(res, 503, {
        ok: false,
        code: 'library_unavailable',
        message: '读取音乐资料失败，暂时无法补歌：' + (err instanceof Error ? err.message : String(err)),
      })
      return
    }

    const result = await forcedRefill(library, this.orchestrator) ?? await this.orchestrator.prepareBatch({
      ...preparationInput(body, this.db.getNumberSetting('refillBatchSize', 5)),
      library,
      libraryComplete: snapshot.complete,
      libraryMessage: snapshot.message,
    })

    if (result.ok) {
      sendJson(res, 200, result)
      return
    }
    sendJson(res, preparationStatus(result.code), result)
  }
}
