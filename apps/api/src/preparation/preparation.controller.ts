/**
 * 选歌与补歌控制器：路由合同见 docs/migration/route-contract.md §3。
 * 旧路由没有严格方法限制的行为不复制到带方法判断的路由（POST only 保持 POST only）。
 */
import { Controller, Post, Get, Res, Body, Query, HttpCode } from '@nestjs/common'
import type { Response } from 'express'
import { NeteaseService } from '../music/netease.service'
import { CodexService } from '../codex/codex.service'
import { OrchestratorService } from './orchestrator.service'
import { DbService } from '../persistence/db.service'
import { sendJson } from '../http/json.util'
import { TEST_HOOKS } from '../config/app-config'
import { testFaults } from '../test-support/fault-state'

@Controller('api')
export class PreparationController {
  constructor(
    private readonly ncm: NeteaseService,
    private readonly codex: CodexService,
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
    const forced = testFaults.forcedRefillError
    if (TEST_HOOKS && forced && forced.remaining > 0) {
      forced.remaining -= 1
      const status = ['candidates_exhausted', 'session_ended'].includes(forced.code) ? 409 : forced.code === 'music_unavailable' ? 503 : 502
      return sendJson(res, status, { ok: false, code: forced.code, message: forced.message })
    }
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
        message: '读取音乐资料失败，暂时无法补歌：' + (err as Error).message,
      })
      return
    }

    const forcedPicks = testFaults.forcedRefillPicks
    if (TEST_HOOKS && forcedPicks && forcedPicks.remaining > 0) {
      forcedPicks.remaining -= 1
      const byId = new Map(library.map((track) => [Number(track.id), track]))
      const checked = await this.orchestrator.checkPlayable(forcedPicks.ids.map((id) => ({
        id, name: byId.get(id)?.name || `测试曲目 ${id}`, artists: byId.get(id)?.artists || '',
        album: byId.get(id)?.album || '', durationMs: byId.get(id)?.durationMs || 0,
        reason: '（测试注入）强制返回的批次',
      })))
      const playable = checked.filter((track) => track.playable)
      if (!playable.length) return sendJson(res, 502, { ok: false, code: 'no_playable', message: '（测试注入）强制批次都不可播' })
      return sendJson(res, 200, { ok: true, picks: playable, dropped: checked.filter((track) => !track.playable), source: 'forced', degraded: false, rejected: [], meta: { forced: true } })
    }

    const result = await this.orchestrator.prepareBatch({
      library,
      libraryComplete: snapshot?.complete,
      libraryMessage: snapshot?.message,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null as unknown as string,
      epoch: Number(body.epoch) || 0,
      excludeIds: Array.isArray(body.excludeIds) ? body.excludeIds : [],
      count: Number(body.count) || this.db.getNumberSetting('refillBatchSize', 5),
      brief: typeof body.brief === 'string' ? body.brief.slice(0, 200) : '',
      timeoutMs: Number(body.timeoutMs) || undefined,
      skipCodex: Boolean(body.skipCodex),
    })

    if (result.ok) {
      sendJson(res, 200, result)
      return
    }
    const code = result.code as string
    const status =
      code === 'session_ended'
        ? 409
        : code === 'candidates_exhausted'
          ? 409
          : code === 'music_unavailable' || code === 'library_unavailable'
            ? 503
            : 502
    sendJson(res, status, result)
  }
}
