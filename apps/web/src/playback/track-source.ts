import type { ResolveResult } from './playback-types'
export type SourceResult = { ok: true; audioUrl: string } | { ok: false; reason: string }
function unavailable(result: ResolveResult): string {
  if (result.code === 'trial_only') return '仅试听片段权限，按规格跳过'
  if (result.code === 'unplayable') return '账号当前无播放权限'
  return result.message || `音源不可用 (HTTP ${result.status})`
}
/** 接入请求与音源错误归一；是否仍允许播放由控制器的意图代次决定。 */
export async function resolveSource(request: () => Promise<ResolveResult>): Promise<SourceResult> {
  try {
    const result = await request()
    if (!result.ok || !result.playable || !result.audioUrl) return { ok: false, reason: unavailable(result) }
    return { ok: true, audioUrl: result.audioUrl }
  } catch (error) {
    return { ok: false, reason: '解析请求失败：' + String(error instanceof Error ? error.message : error) }
  }
}
