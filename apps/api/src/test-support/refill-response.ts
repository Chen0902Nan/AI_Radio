import { TEST_HOOKS } from '../config/app-config'
import { testFaults } from './fault-state'
import type { Track } from '../music/netease.service'
import type { OrchestratorService } from '../preparation/orchestrator.service'

export function takeRefillError() {
  const forced = testFaults.forcedRefillError
  if (!TEST_HOOKS || !forced || forced.remaining <= 0) return null
  forced.remaining -= 1
  return { ok: false as const, code: forced.code, message: forced.message }
}

export async function forcedRefill(library: Track[], orchestrator: OrchestratorService) {
  const forced = testFaults.forcedRefillPicks
  if (!TEST_HOOKS || !forced || forced.remaining <= 0) return null
  forced.remaining -= 1
  const byId = new Map(library.map(track => [track.id, track]))
  const checked = await orchestrator.checkPlayable(forced.ids.map(id => ({
    id, name: byId.get(id)?.name || `测试曲目 ${id}`, artists: byId.get(id)?.artists || '',
    album: byId.get(id)?.album || '', durationMs: byId.get(id)?.durationMs || 0,
    reason: '（测试注入）强制返回的批次',
  })))
  const playable = checked.filter(track => track.playable)
  if (!playable.length) return { ok: false as const, code: 'no_playable', message: '（测试注入）强制批次都不可播' }
  return { ok: true as const, picks: playable, dropped: checked.filter(track => !track.playable), source: 'forced', degraded: false, rejected: [], meta: { forced: true } }
}
