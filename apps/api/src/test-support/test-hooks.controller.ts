/**
 * 测试钩子控制器：仅当显式 RADIO_TEST_HOOKS=1 时由 AppModule 注册。
 * 正常启动不得出现任何可修改测试状态的路由。
 */
import { Controller, All, Post, Get, Body, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { NeteaseService } from '../music/netease.service'
import { CodexService, setCodexMode, getStats, resetStats } from '../codex/codex.service'
import { OrchestratorService } from '../preparation/orchestrator.service'
import { setFishMode } from '../dj/fish.service'
import { setDjScriptMode, getStats as getDjScriptStats } from '../dj/dj-script.service'
import { sendJson } from '../http/json.util'
import { testFaults } from './fault-state'

@Controller('api/_test')
export class TestHooksController {
  constructor(
    private readonly ncm: NeteaseService,
    private readonly codex: CodexService,
    private readonly orchestrator: OrchestratorService,
  ) {}

  @All('fail-next')
  failNext(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    testFaults.injectResolveFailures = Number(body.count ?? 1)
    sendJson(res, 200, { ok: true, pendingFailures: testFaults.injectResolveFailures })
  }

  @All('fail-audio-next')
  failAudioNext(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    testFaults.injectAudioFailures = Number(body.count ?? 1)
    sendJson(res, 200, { ok: true, pendingAudioFailures: testFaults.injectAudioFailures })
  }

  @All('unplayable-next')
  unplayableNext(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    const pending = this.ncm.setInjectedUnplayable(Number(body.count ?? 1))
    sendJson(res, 200, { ok: true, pendingUnplayable: pending })
  }

  @All('resolve-error-next')
  resolveErrorNext(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    const pending = this.ncm.setInjectedResolveErrors(Number(body.count ?? 1))
    sendJson(res, 200, { ok: true, pendingResolveErrors: pending })
  }

  @All('sample-candidates')
  async sampleCandidates(@Res() res: Response, @Query('n') n: string): Promise<void> {
    // 使用生产候选策略，不调用 Codex 或创建播放记录。
    const session = this.ncm.loadSession()
    if (!session) return sendJson(res, 401, { ok: false, code: 'NOT_LOGGED_IN' })
    const library = await this.ncm.selectionLibrary()
    const count = Math.max(1, Math.min(120, Number(n) || 20))
    const { DiscoverySelection } = await import('../preparation/discovery-selection')
    const result = await new DiscoverySelection(this.ncm, this.orchestrator['db']).candidates(library.tracks, library.complete, [], count)
    sendJson(res, 200, {ok: true, ids: result.candidates.slice(0, count).map(t => t.id), librarySize: library.tracks.length, warnings: result.warnings})
  }

  @All('codex-mode')
  codexMode(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    const mode = setCodexMode(body.mode as string, { delayMs: body.delayMs as number })
    sendJson(res, 200, { ok: true, mode, stats: getStats() })
  }

  @All('fish-mode')
  fishMode(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    const mode = setFishMode(body.mode as string, { delayMs: body.delayMs as number })
    sendJson(res, 200, { ok: true, mode })
  }

  @All('dj-script-mode')
  djScriptMode(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    const mode = setDjScriptMode(body.mode as string, { delayMs: body.delayMs as number })
    sendJson(res, 200, { ok: true, mode, stats: getDjScriptStats() })
  }

  @All('codex-stats')
  codexStats(@Res() res: Response, @Query('reset') reset: string): void {
    if (reset === '1') resetStats()
    sendJson(res, 200, { ok: true, stats: getStats() })
  }

  @All('orchestrator-state')
  orchestratorState(@Res() res: Response): void {
    sendJson(res, 200, { ok: true, inflight: this.orchestrator.inflightInfo() })
  }

  @All('clear-url-cache')
  clearUrlCache(@Res() res: Response): void {
    this.ncm.clearUrlCache()
    sendJson(res, 200, { ok: true })
  }

  @All('refill-forced')
  refillForced(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    const count = Number(body.count ?? 1)
    testFaults.forcedRefillError =
      count > 0
        ? {
            code: (body.code as string) || 'candidates_exhausted',
            message: (body.message as string) || '（测试注入）补歌失败',
            remaining: count,
          }
        : null
    sendJson(res, 200, { ok: true, forced: testFaults.forcedRefillError })
  }

  @All('refill-forced-picks')
  refillForcedPicks(@Res() res: Response, @Body() body: Record<string, unknown>): void {
    testFaults.forcedRefillPicks =
      Array.isArray(body.ids) && body.ids.length
        ? { ids: (body.ids as unknown[]).map(Number).filter(Number.isFinite), remaining: Number(body.count ?? 1) }
        : null
    sendJson(res, 200, { ok: true, forcedPicks: testFaults.forcedRefillPicks })
  }
}
