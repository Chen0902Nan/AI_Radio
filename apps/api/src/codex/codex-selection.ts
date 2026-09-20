import type { CodexCandidate } from './codex-types'

function pickList(raw: unknown): unknown[] | null {
  if (!raw || typeof raw !== 'object' || !('picks' in raw) || !Array.isArray(raw.picks)) return null
  return raw.picks
}
function pickFields(item: unknown): { id: unknown; reason: string } {
  if (!item || typeof item !== 'object') return { id: undefined, reason: '' }
  return { id: 'id' in item ? item.id : undefined, reason: 'reason' in item && typeof item.reason === 'string' ? item.reason.trim() : '' }
}

/** 校验模型输出：只保留 id 在候选集里、不重复、且有理由的条目。 */
export function validatePicks(raw: unknown, candidates: CodexCandidate[]): {
  valid: Array<CodexCandidate & { reason: string }>
  rejected: Array<{ id?: unknown; why: string }>
  structurallyInvalid: boolean
} {
  const byId = new Map(candidates.map((c) => [Number(c.id), c]))
  const seen = new Set<number>()
  const valid: Array<CodexCandidate & { reason: string }> = []
  const rejected: Array<{ id?: unknown; why: string }> = []
  const list = pickList(raw)
  if (!list) return { valid, rejected, structurallyInvalid: true }
  for (const item of list) {
    const rec = pickFields(item)
    const id = Number(rec.id)
    const reason = rec.reason
    if (!Number.isFinite(id)) {
      rejected.push({ id: rec.id, why: 'id 不是数字' })
      continue
    }
    if (!byId.has(id)) {
      rejected.push({ id, why: '不在候选集里（模型编造的 id）' })
      continue
    }
    if (seen.has(id)) {
      rejected.push({ id, why: '重复出现' })
      continue
    }
    if (!reason) {
      rejected.push({ id, why: '缺少选歌理由' })
      continue
    }
    seen.add(id)
    valid.push({ ...byId.get(id)!, reason })
  }
  return { valid, rejected, structurallyInvalid: false }
}

export function buildPrompt({ candidates, brief, count }: { candidates: CodexCandidate[]; brief: string; count: number }): string {
  const list = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    artists: c.artists,
    album: c.album,
    minutes: c.durationMs ? Math.round(c.durationMs / 60000) : undefined,
  }))
  return [
    '你是个人电台的选歌助手。下面是一份候选歌曲列表（JSON）。',
    `请从中挑 ${count} 首，按播放顺序排列，用于这样的收听场景：${brief}`,
    '',
    '约束：',
    `- 只能使用候选列表里出现过的 id，绝对不要编造或推测 id。`,
    `- 每首选一句中文理由，不超过 40 字，说明为什么适合这个场景。`,
    '- 不要重复选同一首。',
    '- 只输出结构化结果，不要输出解释过程或额外文字。',
    '',
    '候选列表：',
    JSON.stringify(list),
  ].join('\n')
}
