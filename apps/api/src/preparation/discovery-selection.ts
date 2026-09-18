import type { Track, NeteaseService } from '../music/netease.service'
import type { DbService } from '../persistence/db.service'
import type { CodexCandidate } from '../codex/codex.service'

export type SelectionSource = 'library' | 'discovery'
export type Candidate = Track & { selectionSource: SelectionSource }

/** 真实候选与选择策略；模型只能排序，不能定义归属、权限或比例。 */
export class DiscoverySelection {
  constructor(private ncm: NeteaseService, private db: DbService) {}

  async candidates(library: Track[], complete: boolean, excludeIds: number[], count: number) {
    const feedback = this.db.activeFeedbackMap()
    const excluded = new Set([...excludeIds, ...[...feedback].filter(([,v]) => v === 'dislike').map(([id]) => id)])
    const libraryIds = new Set(library.map(t => t.id))
    const warnings: string[] = []
    let discovery: Track[] = []
    if (complete) {
      try {
        const likes = [...feedback].filter(([, v]) => v === 'like').map(([id]) => id)
        const seeds = [...new Set([...likes, ...shuffled(library).map(t => t.id)])].filter(id => !excluded.has(id)).slice(0, 4)
        const result = await this.ncm.discoveryCandidates(seeds)
        discovery = result.tracks.filter(t => !libraryIds.has(t.id))
        if (result.message) warnings.push(result.message)
        if (!discovery.length) warnings.push('未取得歌单外探索候选，先用歌单内歌曲续播')
      } catch (_) { warnings.push('探索来源暂不可用，先用歌单内歌曲续播') }
    } else warnings.push('歌单资料未读完整，暂缓探索，先播放已确认歌曲')
    const pool = [...new Map([
      ...library.map(t => ({...t, selectionSource: 'library' as const})),
      ...discovery.map(t => ({...t, selectionSource: 'discovery' as const})),
    ].filter(t => !excluded.has(t.id)).map(t => [t.id, t])).values()]
    const recent = new Set(this.db.automaticHistory().map(p => p.track_id))
    // 两类各有独立候选预算，防止数量较大的曲库淹没探索。
    const budget = Math.max(count * 3, Math.min(120, this.db.getNumberSetting('candidateCount', 60)))
    const candidates = (['library', 'discovery'] as const).flatMap(source => {
      const group = shuffled(pool.filter(t => t.selectionSource === source))
      return [...group.filter(t => !recent.has(t.id)), ...group.filter(t => recent.has(t.id))].slice(0, budget)
    })
    return {candidates, recent, warnings}
  }

  async pick(candidates: Candidate[], ranked: Array<CodexCandidate & {reason?: string}>, count: number, recent: Set<number>, isAlive: () => boolean = () => true) {
    const byId = new Map(candidates.map(t => [t.id, t]))
    const ordered = [...new Set([...ranked.map(t => t.id), ...candidates.map(t => t.id)])].map(id => byId.get(id)).filter((t): t is Candidate => Boolean(t))
    const reasons = new Map(ranked.map(t => [t.id, t.reason]))
    const history = this.db.automaticHistory().slice().reverse().map(p => p.selection_source)
    const picks: Array<Candidate & {selectionId: string; playable: true; type: 'track'; reason: string; fromCodex: boolean}> = []
    const dropped: Array<{id: number; why: string}> = []
    let repeated = false
    const probes = {library: 0, discovery: 0}
    const maxProbes = Math.max(12, count * 3)
    const spentMs = {library: 0, discovery: 0}
    // 先用近期未播候选；确实没有足够完整音源才放宽近期限制。
    for (const allowRecent of [false, true]) {
      const remaining = ordered.filter(t => recent.has(t.id) === allowRecent)
      while (remaining.length && picks.length < count) {
        if (!isAlive()) break
        const window = history.slice(-49)
        const discoveryCount = window.filter(s => s === 'discovery').length
        const desired: SelectionSource = discoveryCount < (window.length + 1) / 2 ? 'discovery' : 'library'
        const desiredIndex = remaining.findIndex(t => t.selectionSource === desired)
        const [track] = remaining.splice(desiredIndex < 0 ? 0 : desiredIndex, 1)
        if (probes[track.selectionSource] >= maxProbes || spentMs[track.selectionSource] >= 30_000) continue
        probes[track.selectionSource] += 1
        // 反馈可在准备过程中改变，交付前再次核验。
        if (this.db.activeFeedbackMap().get(track.id) === 'dislike') continue
        const probeStarted = Date.now()
        try {
          const audio = await this.ncm.resolveTrack(track.id)
          if (audio.kind !== 'full') { dropped.push({id: track.id, why: '没有完整可播音源'}); continue }
        } catch (_) { dropped.push({id: track.id, why: '音源查询失败'}); continue }
        finally { spentMs[track.selectionSource] += Date.now() - probeStarted }
        picks.push({...track, selectionId: this.db.registerSelection(track.id, track.selectionSource), type: 'track', playable: true,
          reason: reasons.get(track.id) || '按口味与近期收听记录选择', fromCodex: reasons.has(track.id)})
        history.push(track.selectionSource)
        if (allowRecent) repeated = true
      }
      if (picks.length >= count) break
    }
    const discoveryUnavailable = candidates.some(t => t.selectionSource === 'discovery') && !picks.some(t => t.selectionSource === 'discovery') && dropped.some(t => byId.get(t.id)?.selectionSource === 'discovery')
    return {picks, dropped, repeated, discoveryUnavailable}
  }
}

function shuffled<T>(values: T[]): T[] {
  const result = [...values]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]
  }
  return result
}
