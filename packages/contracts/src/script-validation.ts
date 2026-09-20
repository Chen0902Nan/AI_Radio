import { STORY_STATUSES, CLAIM_KINDS, type StoryStatus, type ClaimKind, SCRIPT_BOUNDS, SOURCE_MAX_EVIDENCE_CHARS, type Source, type SegueScript, type ValidationError, type ValidationDeviation, type ValidationResult } from './models.js'
import { isNonEmptyString, toInt, err, result, failure, estimateSpeechSeconds } from './validation-utils.js'

/**
 * 来源校验。论坛、个人文章、乐迷分享都可以作为来源（不设官方白名单），
 * 只要求是实际访问到的 http(s) 页面并保留短摘录与检索时间。
 */
export function validateSources(sources: unknown): ValidationResult<Source[]> {
  const errors: ValidationError[] = []
  if (!Array.isArray(sources)) return failure([err('sources', 'sources_not_array', 'sources 必须是数组')])
  const seen = new Set<string>()
  sources.forEach((s, i) => {
    const at = `sources[${i}]`
    if (!s || typeof s !== 'object') {
      errors.push(err(at, 'invalid_source', '来源必须是对象'))
      return
    }
    const src = s as Record<string, unknown>
    if (!isNonEmptyString(src.id)) errors.push(err(`${at}.id`, 'invalid_source_id', '来源缺少 id'))
    else if (seen.has(src.id)) errors.push(err(`${at}.id`, 'duplicate_source_id', `来源 id 重复：${src.id}`))
    else seen.add(src.id)
    if (!/^https?:\/\//i.test(typeof src.url === 'string' ? src.url : '')) {
      errors.push(err(`${at}.url`, 'invalid_source_url', '来源 url 必须是 http(s) 绝对链接（接受论坛/个人页面，无白名单）'))
    }
    if (!isNonEmptyString(src.title)) errors.push(err(`${at}.title`, 'missing_source_title', '来源缺少标题'))
    if (!isNonEmptyString(src.evidence)) {
      errors.push(err(`${at}.evidence`, 'missing_source_evidence', '来源缺少支持陈述的摘录/摘要'))
    } else if (src.evidence.length > SOURCE_MAX_EVIDENCE_CHARS) {
      errors.push(err(`${at}.evidence`, 'evidence_too_long', `来源摘录超过 ${SOURCE_MAX_EVIDENCE_CHARS} 字，只保存短摘录或摘要`))
    }
    if (typeof src.publisherOrAuthor !== 'undefined' && typeof src.publisherOrAuthor !== 'string') errors.push(err(`${at}.publisherOrAuthor`, 'invalid_source_author', '来源作者必须是字符串'))
    if (typeof src.retrievedAt !== 'string' || Number.isNaN(Date.parse(src.retrievedAt as string))) {
      errors.push(err(`${at}.retrievedAt`, 'invalid_retrieved_at', '来源缺少可解析的检索时间 retrievedAt'))
    }
  })
  return result(errors.length === 0, sources as Source[], errors)
}

/**
 * 文案成品校验（结构层）：非空稿、长度范围、目标身份、来源引用存在、
 * 未证实说法的播出归因。它不能证明来源支持内容（见文件头验证边界）。
 * opts 可传 {targetTrackId, targetItemId, transitionId, minChars, maxChars} 做机会一致性核对。
 */
export function validateScript(script: unknown, opts: ScriptOptions = {}): ValidationResult<SegueScript> {
  const errors: ValidationError[] = []
  const deviations: ValidationDeviation[] = []
  const push = (path: string, code: string, message: string) => errors.push(err(path, code, message))
  if (!script || typeof script !== 'object') return failure([err('', 'not_object', '文案结果必须是对象')])
  const s = script as Record<string, unknown>

  validateTarget(s, opts, push)
  for (const key of ['targetName', 'targetArtists']) {
    if (s[key] !== undefined && typeof s[key] !== 'string') push(key, 'invalid_context', '目标上下文必须是字符串')
  }
  const text = typeof s.scriptText === 'string' ? s.scriptText : ''
  if (!text.trim()) push('scriptText', 'empty_script', '文案不能为空')
  if (!STORY_STATUSES.includes(s.storyStatus as StoryStatus)) {
    push('storyStatus', 'invalid_story_status', `storyStatus 必须是 ${STORY_STATUSES.join(' 或 ')}`)
  }
  const isSourced = s.storyStatus === 'sourced'

  const sources = validateStorySources(s, isSourced, push)
  validateClaims(s, sources, isSourced, text, push)
  validateLength(text, isSourced, opts, push, deviations)

  return errors.length ? failure(errors, deviations) : result(true, { ...s, targetTrackId: toInt(s.targetTrackId)! } as unknown as SegueScript, [], deviations)
}


type ScriptOptions = { targetTrackId?: number; targetItemId?: string; transitionId?: string; minChars?: number; maxChars?: number }
type PushError = (path: string, code: string, message: string) => void
function validateTarget(s: Record<string, unknown>, opts: ScriptOptions, push: PushError): void {
  // 目标身份是跨目标检测的结构基础：成品必须记录为哪个机会、哪首歌而写。
  if (toInt(s.targetTrackId) === null) push('targetTrackId', 'invalid_target_track_id', '文案必须记录目标歌曲的数字 id')
  if (!isNonEmptyString(s.targetItemId)) push('targetItemId', 'missing_target_item_id', '文案必须记录目标条目 itemId')
  if (!isNonEmptyString(s.transitionId)) push('transitionId', 'missing_transition_id', '文案必须记录当前机会 transitionId')
  validateTargetMatch(s, opts, push)
}
function validateTargetMatch(s: Record<string, unknown>, opts: ScriptOptions, push: PushError): void {
  if (opts.targetTrackId !== undefined && toInt(s.targetTrackId) !== null && toInt(s.targetTrackId) !== toInt(opts.targetTrackId)) {
    push('targetTrackId', 'target_mismatch', '文案不是为当前目标歌曲生成的')
  }
  if (opts.targetItemId !== undefined && s.targetItemId !== opts.targetItemId) {
    push('targetItemId', 'target_mismatch', '文案不是为当前目标条目生成的')
  }
  if (opts.transitionId !== undefined && s.transitionId !== opts.transitionId) {
    push('transitionId', 'transition_mismatch', '文案不是为当前机会生成的')
  }
}

function validateStorySources(s: Record<string, unknown>, isSourced: boolean, push: PushError): unknown[] | null {
  // 来源
  const sources = Array.isArray(s.sources) ? s.sources : null
  if (!sources) push('sources', 'sources_not_array', 'sources 必须是数组')
  if (sources && !isSourced && sources.length > 0) {
    push('sources', 'basic_only_with_sources', 'basic_only 表示查无可用资料，不应携带来源')
  }
  if (sources && isSourced) {
    if (sources.length === 0) push('sources', 'no_sources', 'sourced 文案必须至少携带一个来源')
    validateSources(sources).errors.forEach((e) => push(e.path, e.code, e.message))
  }

  return sources
}
function validateClaims(s: Record<string, unknown>, sources: unknown[] | null, isSourced: boolean, text: string, push: PushError): void {
  // 陈述
  const claims = Array.isArray(s.claims) ? s.claims : null
  if (!claims) push('claims', 'claims_not_array', 'claims 必须是数组')
  if (claims) {
    if (isSourced && claims.length === 0) push('claims', 'no_claims', 'sourced 文案必须至少包含一条陈述')
    if (!isSourced && claims.length > 0) push('claims', 'basic_only_with_claims', 'basic_only 不应携带陈述')
    const sourceIds = new Set((sources || []).map((x: unknown) => (x as Source)?.id).filter(isNonEmptyString))
    const seenClaimIds = new Set<string>()
    claims.forEach((claim, i) => {
      const at = `claims[${i}]`
      if (!claim || typeof claim !== 'object') {
        push(at, 'invalid_claim', '陈述必须是对象')
        return
      }
      const c = claim as Record<string, unknown>
      if (!isNonEmptyString(c.id)) push(`${at}.id`, 'invalid_claim_id', '陈述缺少 id')
      else if (seenClaimIds.has(c.id)) push(`${at}.id`, 'duplicate_claim_id', `陈述 id 重复：${c.id}`)
      else seenClaimIds.add(c.id)
      if (!isNonEmptyString(c.text)) push(`${at}.text`, 'empty_claim_text', '陈述缺少内容')
      if (!CLAIM_KINDS.includes(c.kind as ClaimKind)) {
        push(`${at}.kind`, 'invalid_claim_kind', `kind 必须是 ${CLAIM_KINDS.join(' 或 ')}`)
      }
      validateClaimReferences(c, at, sourceIds, push)
      validateAttribution(c, at, text, push)
      // documented 的 spokenAttribution 可选：网页展示来源即可，不强制口播归因。
    })
  }
}

function validateLength(text: string, isSourced: boolean, opts: ScriptOptions, push: PushError, deviations: ValidationDeviation[]): void {
  // 长度范围
  const minChars = Number(opts.minChars) > 0 ? Number(opts.minChars) : SCRIPT_BOUNDS.minChars
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : SCRIPT_BOUNDS.maxChars
  if (text.trim()) {
    if (text.length > maxChars) {
      push('scriptText', 'script_too_long', `文案超过 ${maxChars} 字上限（约 30 秒）`)
    } else if (text.length < minChars) {
      if (isSourced) {
        push('scriptText', 'script_too_short', `资料型文案不足 ${minChars} 字（约 15 秒），应收窄内容或降级为 basic_only`)
      } else {
        // 契约允许：少于 15 秒的有效基础介绍可以降级使用，但要明确记录偏差。
        deviations.push({
          code: 'short_basic_intro',
          message: `基础介绍短于目标长度 ${minChars} 字，按契约降级使用`,
          estimatedSeconds: estimateSpeechSeconds(text),
        })
      }
    }
  }
}

function validateClaimReferences(c: Record<string, unknown>, at: string, sourceIds: Set<string>, push: PushError): void {
  if (!Array.isArray(c.sourceIds)) {
    push(`${at}.sourceIds`, 'claim_without_source', '陈述必须以数组形式引用来源')
  } else if (c.sourceIds.length === 0) {
    push(`${at}.sourceIds`, 'claim_without_source', '陈述必须引用至少一个来源')
  } else {
    const missing = c.sourceIds.filter((id: unknown) => !sourceIds.has(id as string))
    if (missing.length) push(`${at}.sourceIds`, 'missing_source_reference', `引用了不存在的来源：${missing.join(', ')}`)
  }
}
function validateAttribution(c: Record<string, unknown>, at: string, text: string, push: PushError): void {
  if (c.spokenAttribution !== undefined && typeof c.spokenAttribution !== 'string') {
    push(`${at}.spokenAttribution`, 'invalid_spoken_attribution', 'spokenAttribution 必须是字符串')
  } else if (c.kind === 'unverified_account') {
    // 民间说法必须在播报文字里自然说明出处与说法性质，隐藏元数据标记不算。
    if (!isNonEmptyString(c.spokenAttribution)) {
      push(`${at}.spokenAttribution`, 'missing_spoken_attribution', '未证实说法必须携带实际播出的归因文字')
    } else if (text && !text.includes(c.spokenAttribution)) {
      push(`${at}.spokenAttribution`, 'attribution_missing_in_script', '归因文字必须出现在播报正文中，而不是只在元数据里')
    }
  }
}
