/**
 * 节目契约（DJ 串场任务 01）：歌曲与 DJ 播报共用的数据形状、身份语义与结构校验。
 *
 * 身份区分（对应开发契约第 1 节，实现不得混用）：
 *  - sessionId  当前收听会话；停止后旧会话的结果一律失效。
 *  - epoch      编排版本：切来源、应用新计划或重置节目时更新。
 *               不能用暂停也会变化的 playToken 代替。
 *  - itemId     一次入队的节目条目身份；同一首歌重复入队也不同。
 *  - trackId    音乐平台歌曲 ID；旧歌曲对象的数字 id 只在 makeTrackItem 适配边界映射，
 *               不用于识别一次串场机会。
 *  - transitionId 一次「当前歌曲结束 → 目标歌曲开始」的串场机会；
 *               绑定当前/目标条目，机会关闭后不重新打开。
 *  - segueId    一次准备任务及其播报成品身份；用于查询、取消与媒体归属。
 *  - playInstanceId 一次实际播放尝试：暂停恢复复用，重新开始同一条目则新建，
 *               供 ended/首次 playing 去重；独立于数据库异步取得的歌曲 playId。
 *  - playToken  播放执行代次：控制加载/播放回调能否生效，与准备任务版本分开。
 *
 * track 与 segue 是两种节目内容。歌曲反馈、播放记录、补歌去重与待播数量只看 track。
 *
 * 验证边界（重要）：本模块的结构校验只能证明「形状正确、身份一致、归因文字存在」，
 * 不能程序性证明来源内容属实或陈述为真。documented 也不等于对客观真实性的绝对保证；
 * 来源是否真的支持陈述，必须用真实案例人工核对（任务 07/08 取证）。
 *
 * 本文件同时是 CommonJS 模块，浏览器全局名 RadioProgramContract，便于 Node 单元测试。
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.RadioProgramContract = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  /* ---------- 枚举与常量 ---------- */

  const PROGRAM_TYPES = ['track', 'segue']
  const STORY_STATUSES = ['sourced', 'basic_only']
  const CLAIM_KINDS = ['documented', 'unverified_account']
  const JOB_STATES = ['preparing', 'ready', 'unavailable', 'stale']
  const JOB_STAGES = ['research', 'synthesis']
  const TRANSITION_STATES = ['open', 'closed']

  /** 任务不可用原因（契约第 5 节：失败状态分开记录）。 */
  const UNAVAILABLE_REASONS = [
    'voice_not_configured', // 未配置密钥/有效音色，未发起合成
    'script_failed', // Codex 搜索/写稿失败
    'synthesis_failed', // TTS 失败
    'audio_invalid', // 返回内容不是有效音频
    'audio_too_long', // 成品超过 30 秒，不进入正式节目
    'target_unplayable', // 目标歌曲确认不可完整播放，撤销 DJ
    'cancelled', // 被取消（跳过/停止/新机会）
    'cooldown_active', // 连续失败的有界冷却中
  ]
  /** 任务作废原因（stale = 旧结果失去排程资格）。 */
  const STALE_REASONS = [
    'transition_closed', // 机会已关闭（自然结束决定不播 DJ / 被跳过）
    'superseded', // 被同一会话更新的机会取代
    'session_ended', // 收听会话已停止
    'epoch_changed', // 编排版本更新（换来源/新计划/重置队列）
    'server_restart', // 服务重启，进程内任务失效
    'expired', // 完成后保留期（5 分钟）已过
  ]
  /** 文案阶段失败码（与 server/codex.js 的失败分类保持一致）。 */
  const SCRIPT_FAILURE_CODES = ['timeout', 'quota', 'auth', 'invalid_output', 'network', 'error']
  /** 语音阶段失败码。 */
  const TTS_FAILURE_CODES = [
    'not_configured', 'auth', 'quota', 'rate_limited', 'timeout',
    'bad_audio', 'too_long', 'network', 'cancelled', 'error',
  ]

  /** 事件输入形状（04 控制器接收、06 播放器上报）。 */
  const EVENTS = {
    TRACK_PLAYING: 'track-playing',
    TRACK_ENDED: 'track-ended',
    TRACK_FAILED: 'track-failed',
    SEGUE_PLAYING: 'segue-playing',
    SEGUE_ENDED: 'segue-ended',
    SEGUE_FAILED: 'segue-failed',
    QUEUE_CHANGED: 'queue-changed',
    PAUSED: 'paused',
    RESUMED: 'resumed',
    STOPPED: 'stopped',
    PREPARE_RESULT: 'prepare-result',
  }
  const EVENT_LIST = Object.values(EVENTS)
  const PLAYBACK_EVENT_TYPES = [
    EVENTS.TRACK_PLAYING, EVENTS.TRACK_ENDED, EVENTS.TRACK_FAILED,
    EVENTS.SEGUE_PLAYING, EVENTS.SEGUE_ENDED, EVENTS.SEGUE_FAILED,
  ]

  /** 决定输出形状（04 控制器返回、06 执行）。 */
  const DECISIONS = {
    PREPARE: 'prepare', // 提交串场准备请求
    CANCEL: 'cancel', // 作废未播任务/在途准备
    PLAY_SEGUE: 'play-segue', // 当前歌曲自然结束且 DJ 就绪：播报
    CONTINUE_TRACK: 'continue-track', // 继续播放下一首歌曲（放弃或未就绪）
    NONE: 'none',
  }
  const DECISION_LIST = Object.values(DECISIONS)

  /**
   * 文案长度边界：15–30 秒目标，按 3.3–4.7 字/秒折算约 50–140 字。
   * sourced 稿越界拒绝；basic_only 短于下限允许降级使用并记录偏差（契约第 4 节）。
   */
  const SCRIPT_BOUNDS = { minChars: 50, maxChars: 140 }
  /** 音频时长硬上限：超过 30 秒不进入正式节目（契约第 4 节）。 */
  const MAX_AUDIO_MS = 30000
  /** 准备请求允许携带的有限上下文长度（契约第 5 节）。 */
  const MAX_CONTEXT_CHARS = 200
  /** 来源只保存支持陈述所需的短摘录/摘要，不缓存整篇文章。 */
  const SOURCE_MAX_EVIDENCE_CHARS = 400
  /** 音频地址前缀：ready 成品必须经同源路由提供，不接受外部 URL。 */
  const AUDIO_URL_PREFIX = '/api/dj/audio/'

  /* ---------- 基础工具 ---------- */

  let __seq = 0
  function makeId(prefix) {
    __seq = (__seq + 1) % 0xffff
    return `${prefix}_${Date.now().toString(36)}${__seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  }

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0
  }

  /** 数字或数字字符串 → 非负整数；否则 null。用于 trackId/epoch 等平台数字身份。 */
  function toInt(v) {
    const n = Number(v)
    return Number.isInteger(n) && n >= 0 ? n : null
  }

  const err = (path, code, message) => ({ path, code, message })
  const result = (ok, value, errors, deviations) => ({ ok, value, errors: errors || [], deviations: deviations || [] })

  /** 估算中文播报时长（秒）：CJK/全角字符记 1，其他可见字符记 0.5，忽略空白。 */
  function estimateSpeechSeconds(text, charsPerSecond) {
    const s = String(text || '')
    let units = 0
    for (const ch of s) {
      if (/\s/.test(ch)) continue
      units += /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1 : 0.5
    }
    const cps = Number(charsPerSecond) > 0 ? Number(charsPerSecond) : 4
    return units / cps
  }

  /* ---------- 身份工厂 ---------- */

  /**
   * 旧歌曲对象 → 节目条目（适配边界）：数字 id 映射为 trackId 后丢弃，
   * 每次入队生成新的 itemId——同一首歌重复入队也是不同条目。
   */
  function makeTrackItem(track, opts = {}) {
    if (!track || typeof track !== 'object') throw new TypeError('makeTrackItem: 需要曲目对象')
    const trackId = toInt(track.trackId !== undefined ? track.trackId : track.id)
    if (trackId === null) throw new TypeError('makeTrackItem: 缺少可用的数字曲目 id（旧结构 id 或 trackId）')
    return {
      itemId: opts.itemId || makeId('itn'),
      type: 'track',
      trackId,
      name: String(track.name || ''),
      artists: String(track.artists || ''),
      album: String(track.album || ''),
      durationMs: Number(track.durationMs) || 0,
      auto: Boolean(track.auto),
      fromCodex: Boolean(track.fromCodex),
      addedAt: Number(opts.addedAt) || Date.now(),
    }
  }

  /** 播报条目：携带 segueId 与机会绑定，绝不携带歌曲数字 id。 */
  function makeSegueItem(input = {}) {
    return {
      itemId: input.itemId || makeId('itn'),
      type: 'segue',
      segueId: String(input.segueId || makeId('sg')),
      transitionId: String(input.transitionId || ''),
      fromItemId: String(input.fromItemId || ''),
      targetItemId: String(input.targetItemId || ''),
      targetTrackId: input.targetTrackId === undefined ? null : toInt(input.targetTrackId),
      script: input.script || null,
      audio: input.audio || null,
      createdAt: Number(input.createdAt) || Date.now(),
    }
  }

  /** 一次「当前歌曲结束 → 目标歌曲开始」的串场机会。 */
  function makeTransition(input = {}) {
    return {
      transitionId: input.transitionId || makeId('tr'),
      sessionId: String(input.sessionId || ''),
      epoch: Number(input.epoch) || 0,
      fromItemId: String(input.fromItemId || ''),
      targetItemId: String(input.targetItemId || ''),
      targetTrackId: toInt(input.targetTrackId),
      state: 'open',
      createdAt: Number(input.createdAt) || Date.now(),
    }
  }

  /** 关闭机会（幂等）；关闭后所有迟到结果失去排程资格，机会不重新打开。 */
  function closeTransition(transition, reason = 'closed') {
    if (!transition || transition.state === 'closed') return transition
    return { ...transition, state: 'closed', closedAt: Date.now(), closedReason: String(reason) }
  }

  function isTransitionOpen(transition) {
    return Boolean(transition) && transition.state === 'open'
  }

  /** 任务复用键：同一个 (sessionId, epoch, transitionId) 的重复提交复用任务。 */
  function transitionKey(t) {
    return `${t && t.sessionId}#${Number(t && t.epoch)}#${t && t.transitionId}`
  }

  /* ---------- 校验器 ---------- */

  function validateTransition(t, opts = {}) {
    const errors = []
    if (!t || typeof t !== 'object') return result(false, undefined, [err('', 'not_object', '机会必须是对象')])
    if (!isNonEmptyString(t.transitionId)) errors.push(err('transitionId', 'missing_transition_id', '缺少 transitionId'))
    if (!isNonEmptyString(t.sessionId)) errors.push(err('sessionId', 'missing_session_id', '缺少 sessionId'))
    if (!Number.isFinite(Number(t.epoch))) errors.push(err('epoch', 'invalid_epoch', 'epoch 必须是数字'))
    if (!isNonEmptyString(t.fromItemId)) errors.push(err('fromItemId', 'missing_from_item_id', '缺少 fromItemId'))
    if (!isNonEmptyString(t.targetItemId)) errors.push(err('targetItemId', 'missing_target_item_id', '缺少 targetItemId'))
    else if (t.targetItemId === t.fromItemId) errors.push(err('targetItemId', 'same_from_and_target', '目标条目不能等于来源条目'))
    if (toInt(t.targetTrackId) === null) errors.push(err('targetTrackId', 'invalid_target_track_id', '缺少数字 targetTrackId'))
    if (!TRANSITION_STATES.includes(t.state)) errors.push(err('state', 'invalid_transition_state', `state 必须是 ${TRANSITION_STATES.join(' 或 ')}`))
    if (opts.sessionId !== undefined && t.sessionId !== opts.sessionId) errors.push(err('sessionId', 'session_mismatch', '机会属于其他收听会话'))
    if (opts.epoch !== undefined && Number(t.epoch) !== Number(opts.epoch)) errors.push(err('epoch', 'epoch_mismatch', '机会属于旧编排版本'))
    return result(errors.length === 0, t, errors)
  }

  function validateQueueItem(item) {
    const errors = []
    if (!item || typeof item !== 'object') return result(false, undefined, [err('', 'not_object', '节目条目必须是对象')])
    if (!isNonEmptyString(item.itemId)) errors.push(err('itemId', 'missing_item_id', '条目缺少 itemId'))
    if (item.type === undefined && item.id !== undefined && toInt(item.id) !== null) {
      errors.push(err('type', 'legacy_track_shape', '旧歌曲对象（只有数字 id）需先经 makeTrackItem 适配为节目条目'))
    } else if (!PROGRAM_TYPES.includes(item.type)) {
      errors.push(err('type', 'invalid_program_type', `type 必须是 ${PROGRAM_TYPES.join(' 或 ')}`))
    }
    if (item.type === 'track') {
      if (toInt(item.trackId) === null) errors.push(err('trackId', 'invalid_track_id', '歌曲条目缺少数字 trackId'))
    }
    if (item.type === 'segue') {
      if (!isNonEmptyString(item.segueId)) errors.push(err('segueId', 'missing_segue_id', '播报条目缺少 segueId'))
      if (Object.prototype.hasOwnProperty.call(item, 'id') && Number.isFinite(Number(item.id))) {
        errors.push(err('id', 'segue_masquerades_track_id', '播报条目不能携带歌曲数字 id'))
      }
    }
    return result(errors.length === 0, item, errors)
  }

  function validatePrepareRequest(req) {
    const errors = []
    if (!req || typeof req !== 'object') return result(false, undefined, [err('', 'not_object', '准备请求必须是对象')])
    if (!isNonEmptyString(req.sessionId)) errors.push(err('sessionId', 'missing_session_id', '缺少 sessionId'))
    if (!Number.isFinite(Number(req.epoch))) errors.push(err('epoch', 'invalid_epoch', 'epoch 必须是数字'))
    if (!isNonEmptyString(req.transitionId)) errors.push(err('transitionId', 'missing_transition_id', '缺少 transitionId'))
    if (!isNonEmptyString(req.fromItemId)) errors.push(err('fromItemId', 'missing_from_item_id', '缺少 fromItemId'))
    if (!isNonEmptyString(req.targetItemId)) errors.push(err('targetItemId', 'missing_target_item_id', '缺少 targetItemId'))
    else if (isNonEmptyString(req.fromItemId) && req.targetItemId === req.fromItemId) {
      errors.push(err('targetItemId', 'same_from_and_target', '目标条目不能等于来源条目'))
    }
    if (toInt(req.targetTrackId) === null) errors.push(err('targetTrackId', 'invalid_target_track_id', '缺少数字 targetTrackId'))
    if (req.brief !== undefined && req.brief !== null && typeof req.brief !== 'string') {
      errors.push(err('brief', 'invalid_brief', 'brief 必须是字符串'))
    } else if (typeof req.brief === 'string' && req.brief.length > MAX_CONTEXT_CHARS) {
      errors.push(err('brief', 'brief_too_long', `上下文超过 ${MAX_CONTEXT_CHARS} 字上限`))
    }
    // 目标名称/歌手为可选上下文（客户端队列里已有，供文案稿使用），长度受限
    for (const [k, cap] of [['targetName', 200], ['targetArtists', 200]]) {
      const v = req[k]
      if (v !== undefined && v !== null && typeof v !== 'string') {
        errors.push(err(k, `invalid_${k}`, `${k} 必须是字符串`))
      } else if (typeof v === 'string' && v.length > cap) {
        errors.push(err(k, `invalid_${k}`, `${k} 超过 ${cap} 字上限`))
      }
    }
    if (errors.length) return result(false, undefined, errors)
    return result(true, {
      sessionId: req.sessionId,
      epoch: Number(req.epoch),
      transitionId: req.transitionId,
      fromItemId: req.fromItemId,
      targetItemId: req.targetItemId,
      targetTrackId: toInt(req.targetTrackId),
      // 目标名称/歌手是文案模块搜索与写稿的输入：校验后必须原样带过去，
      // 否则生成器只能拿到「曲目 <id> / 空歌手」（真实音源接口不返回名称）。
      targetName: typeof req.targetName === 'string' ? req.targetName.trim() : '',
      targetArtists: typeof req.targetArtists === 'string' ? req.targetArtists.trim() : '',
      brief: typeof req.brief === 'string' ? req.brief : '',
    })
  }

  /**
   * 任务与准备请求是否同一机会且同一目标：
   * 只有完全一致才允许复用任务；不同 payload 不能悄悄复用同一键。
   */
  function jobMatchesPrepare(job, req) {
    if (!job || !job.transition || !req) return { match: false, reason: 'missing_input' }
    if (job.transition.sessionId !== req.sessionId) return { match: false, reason: 'session_mismatch' }
    if (Number(job.transition.epoch) !== Number(req.epoch)) return { match: false, reason: 'epoch_mismatch' }
    if (job.transition.transitionId !== req.transitionId) return { match: false, reason: 'transition_mismatch' }
    if (job.transition.targetItemId !== req.targetItemId) return { match: false, reason: 'target_item_mismatch' }
    if (toInt(job.transition.targetTrackId) !== toInt(req.targetTrackId)) return { match: false, reason: 'target_track_mismatch' }
    return { match: true, reason: null }
  }

  /**
   * 来源校验。论坛、个人文章、乐迷分享都可以作为来源（不设官方白名单），
   * 只要求是实际访问到的 http(s) 页面并保留短摘录与检索时间。
   */
  function validateSources(sources) {
    const errors = []
    if (!Array.isArray(sources)) return result(false, undefined, [err('sources', 'sources_not_array', 'sources 必须是数组')])
    const seen = new Set()
    sources.forEach((s, i) => {
      const at = `sources[${i}]`
      if (!s || typeof s !== 'object') {
        errors.push(err(at, 'invalid_source', '来源必须是对象'))
        return
      }
      if (!isNonEmptyString(s.id)) errors.push(err(`${at}.id`, 'invalid_source_id', '来源缺少 id'))
      else if (seen.has(s.id)) errors.push(err(`${at}.id`, 'duplicate_source_id', `来源 id 重复：${s.id}`))
      else seen.add(s.id)
      if (!/^https?:\/\//i.test(typeof s.url === 'string' ? s.url : '')) {
        errors.push(err(`${at}.url`, 'invalid_source_url', '来源 url 必须是 http(s) 绝对链接（接受论坛/个人页面，无白名单）'))
      }
      if (!isNonEmptyString(s.title)) errors.push(err(`${at}.title`, 'missing_source_title', '来源缺少标题'))
      if (!isNonEmptyString(s.evidence)) {
        errors.push(err(`${at}.evidence`, 'missing_source_evidence', '来源缺少支持陈述的摘录/摘要'))
      } else if (s.evidence.length > SOURCE_MAX_EVIDENCE_CHARS) {
        errors.push(err(`${at}.evidence`, 'evidence_too_long', `来源摘录超过 ${SOURCE_MAX_EVIDENCE_CHARS} 字，只保存短摘录或摘要`))
      }
      if (s.retrievedAt === undefined || Number.isNaN(Date.parse(s.retrievedAt))) {
        errors.push(err(`${at}.retrievedAt`, 'invalid_retrieved_at', '来源缺少可解析的检索时间 retrievedAt'))
      }
    })
    return result(errors.length === 0, sources, errors)
  }

  /**
   * 文案成品校验（结构层）：非空稿、长度范围、目标身份、来源引用存在、
   * 未证实说法的播出归因。它不能证明来源支持内容（见文件头验证边界）。
   * opts 可传 {targetTrackId, targetItemId, transitionId, minChars, maxChars} 做机会一致性核对。
   */
  function validateScript(script, opts = {}) {
    const errors = []
    const deviations = []
    const push = (path, code, message) => errors.push(err(path, code, message))
    if (!script || typeof script !== 'object') return result(false, undefined, [err('', 'not_object', '文案结果必须是对象')])

    // 目标身份是跨目标检测的结构基础：成品必须记录为哪个机会、哪首歌而写。
    if (toInt(script.targetTrackId) === null) push('targetTrackId', 'invalid_target_track_id', '文案必须记录目标歌曲的数字 id')
    if (!isNonEmptyString(script.targetItemId)) push('targetItemId', 'missing_target_item_id', '文案必须记录目标条目 itemId')
    if (!isNonEmptyString(script.transitionId)) push('transitionId', 'missing_transition_id', '文案必须记录当前机会 transitionId')
    if (opts.targetTrackId !== undefined && toInt(script.targetTrackId) !== null && toInt(script.targetTrackId) !== toInt(opts.targetTrackId)) {
      push('targetTrackId', 'target_mismatch', '文案不是为当前目标歌曲生成的')
    }
    if (opts.targetItemId !== undefined && script.targetItemId !== opts.targetItemId) {
      push('targetItemId', 'target_mismatch', '文案不是为当前目标条目生成的')
    }
    if (opts.transitionId !== undefined && script.transitionId !== opts.transitionId) {
      push('transitionId', 'transition_mismatch', '文案不是为当前机会生成的')
    }

    const text = typeof script.scriptText === 'string' ? script.scriptText : ''
    if (!text.trim()) push('scriptText', 'empty_script', '文案不能为空')
    if (!STORY_STATUSES.includes(script.storyStatus)) {
      push('storyStatus', 'invalid_story_status', `storyStatus 必须是 ${STORY_STATUSES.join(' 或 ')}`)
    }
    const isSourced = script.storyStatus === 'sourced'

    // 来源
    const sources = Array.isArray(script.sources) ? script.sources : null
    if (!sources) push('sources', 'sources_not_array', 'sources 必须是数组')
    if (sources && !isSourced && sources.length > 0) {
      push('sources', 'basic_only_with_sources', 'basic_only 表示查无可用资料，不应携带来源')
    }
    let sourcesResult = { errors: [] }
    if (sources && isSourced) {
      if (sources.length === 0) push('sources', 'no_sources', 'sourced 文案必须至少携带一个来源')
      sourcesResult = validateSources(sources)
      sourcesResult.errors.forEach((e) => push(e.path, e.code, e.message))
    }

    // 陈述
    const claims = Array.isArray(script.claims) ? script.claims : null
    if (!claims) push('claims', 'claims_not_array', 'claims 必须是数组')
    if (claims) {
      if (isSourced && claims.length === 0) push('claims', 'no_claims', 'sourced 文案必须至少包含一条陈述')
      if (!isSourced && claims.length > 0) push('claims', 'basic_only_with_claims', 'basic_only 不应携带陈述')
      const sourceIds = new Set((sources || []).map((s) => s && s.id).filter(isNonEmptyString))
      const seenClaimIds = new Set()
      claims.forEach((claim, i) => {
        const at = `claims[${i}]`
        if (!claim || typeof claim !== 'object') {
          push(at, 'invalid_claim', '陈述必须是对象')
          return
        }
        if (!isNonEmptyString(claim.id)) push(`${at}.id`, 'invalid_claim_id', '陈述缺少 id')
        else if (seenClaimIds.has(claim.id)) push(`${at}.id`, 'duplicate_claim_id', `陈述 id 重复：${claim.id}`)
        else seenClaimIds.add(claim.id)
        if (!isNonEmptyString(claim.text)) push(`${at}.text`, 'empty_claim_text', '陈述缺少内容')
        if (!CLAIM_KINDS.includes(claim.kind)) {
          push(`${at}.kind`, 'invalid_claim_kind', `kind 必须是 ${CLAIM_KINDS.join(' 或 ')}`)
        }
        if (!Array.isArray(claim.sourceIds)) {
          push(`${at}.sourceIds`, 'claim_without_source', '陈述必须以数组形式引用来源')
        } else if (claim.sourceIds.length === 0) {
          push(`${at}.sourceIds`, 'claim_without_source', '陈述必须引用至少一个来源')
        } else {
          const missing = claim.sourceIds.filter((id) => !sourceIds.has(id))
          if (missing.length) push(`${at}.sourceIds`, 'missing_source_reference', `引用了不存在的来源：${missing.join(', ')}`)
        }
        if (claim.spokenAttribution !== undefined && typeof claim.spokenAttribution !== 'string') {
          push(`${at}.spokenAttribution`, 'invalid_spoken_attribution', 'spokenAttribution 必须是字符串')
        } else if (claim.kind === 'unverified_account') {
          // 民间说法必须在播报文字里自然说明出处与说法性质，隐藏元数据标记不算。
          if (!isNonEmptyString(claim.spokenAttribution)) {
            push(`${at}.spokenAttribution`, 'missing_spoken_attribution', '未证实说法必须携带实际播出的归因文字')
          } else if (text && !text.includes(claim.spokenAttribution)) {
            push(`${at}.spokenAttribution`, 'attribution_missing_in_script', '归因文字必须出现在播报正文中，而不是只在元数据里')
          }
        }
        // documented 的 spokenAttribution 可选：网页展示来源即可，不强制口播归因。
      })
    }

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

    return result(errors.length === 0, script, errors, deviations)
  }

  /**
   * 准备任务校验：身份完整、状态合法、状态专属字段一致。
   * ready 成品必须携带通过校验的文案与同源音频；跨目标成品在这里被拒绝。
   */
  function validateSegueJob(job, opts = {}) {
    const errors = []
    const push = (path, code, message) => errors.push(err(path, code, message))
    if (!job || typeof job !== 'object') return result(false, undefined, [err('', 'not_object', '任务必须是对象')])
    if (!isNonEmptyString(job.segueId)) push('segueId', 'missing_segue_id', '任务缺少 segueId')
    if (!JOB_STATES.includes(job.state)) push('state', 'invalid_job_state', `state 必须是 ${JOB_STATES.join('/')}`)
    if (!Number.isFinite(Number(job.createdAt))) push('createdAt', 'missing_created_at', '任务缺少 createdAt')

    const t = job.transition
    if (!t || typeof t !== 'object') {
      push('transition', 'missing_transition_identity', '任务必须携带机会身份（sessionId/epoch/transitionId/前后条目/目标歌曲）')
    } else {
      const r = validateTransition(t)
      r.errors.forEach((e) => push(`transition.${e.path}`, e.code, e.message))
      if (opts.sessionId !== undefined && t.sessionId !== opts.sessionId) push('transition.sessionId', 'session_mismatch', '任务属于其他收听会话')
      if (opts.epoch !== undefined && Number(t.epoch) !== Number(opts.epoch)) push('transition.epoch', 'epoch_mismatch', '任务属于旧编排版本')
      if (opts.transitionId !== undefined && t.transitionId !== opts.transitionId) push('transition.transitionId', 'transition_mismatch', '任务属于已关闭的机会')
    }

    if (job.stage !== undefined && job.stage !== null && !JOB_STAGES.includes(job.stage)) {
      push('stage', 'invalid_stage', `stage 必须是 ${JOB_STAGES.join(' 或 ')}`)
    }

    if (job.state === 'ready') {
      if (!job.script) push('script', 'missing_script', 'ready 任务必须携带文案成品')
      else {
        const expect = t && typeof t === 'object'
          ? { targetTrackId: t.targetTrackId, targetItemId: t.targetItemId, transitionId: t.transitionId }
          : {}
        const r = validateScript(job.script, expect)
        r.errors.forEach((e) => push(`script.${e.path}`, e.code, e.message))
      }
      if (!job.audio || typeof job.audio !== 'object') {
        push('audio', 'missing_audio', 'ready 任务必须携带音频成品')
      } else {
        if (!isNonEmptyString(job.audio.assetId)) push('audio.assetId', 'invalid_asset_id', '音频成品缺少 assetId')
        const url = typeof job.audio.url === 'string' ? job.audio.url : ''
        if (!url.startsWith(AUDIO_URL_PREFIX) || url.includes('://')) {
          push('audio.url', 'invalid_audio_url', `音频必须通过同源 ${AUDIO_URL_PREFIX} 地址提供，不接受外部 URL`)
        }
        const dur = Number(job.audio.durationMs)
        if (!Number.isFinite(dur) || dur <= 0) {
          push('audio.durationMs', 'invalid_audio_duration', '音频成品必须记录正数时长 durationMs')
        } else if (dur > MAX_AUDIO_MS) {
          push('audio.durationMs', 'audio_too_long', `音频超过 ${MAX_AUDIO_MS / 1000} 秒上限，不能进入正式节目`)
        }
      }
    }
    if (job.state === 'preparing' && (job.script || job.audio)) {
      push('state', 'premature_result', 'preparing 任务不应提前携带成品')
    }
    if (job.state === 'unavailable') {
      if (!UNAVAILABLE_REASONS.includes(job.reason)) {
        push('reason', 'invalid_unavailable_reason', `不可用原因必须在枚举内：${UNAVAILABLE_REASONS.join('/')}`)
      }
      if (job.audio) push('audio', 'unavailable_with_audio', 'unavailable 任务不应携带音频成品')
    }
    if (job.state === 'stale' && !STALE_REASONS.includes(job.reason)) {
      push('reason', 'invalid_stale_reason', `作废原因必须在枚举内：${STALE_REASONS.join('/')}`)
    }
    return result(errors.length === 0, job, errors)
  }

  /* ---------- 事件与决定 ---------- */

  function validateEvent(ev) {
    const errors = []
    if (!ev || typeof ev !== 'object') return result(false, undefined, [err('', 'not_object', '事件必须是对象')])
    if (!EVENT_LIST.includes(ev.type)) errors.push(err('type', 'invalid_event_type', `未知事件类型：${ev.type}`))
    if (!Number.isFinite(Number(ev.at))) errors.push(err('at', 'missing_at', '事件缺少时间戳 at'))
    if (PLAYBACK_EVENT_TYPES.includes(ev.type)) {
      if (!isNonEmptyString(ev.itemId)) errors.push(err('itemId', 'missing_item_id', '播放事件缺少条目身份 itemId'))
      if (!isNonEmptyString(ev.playInstanceId)) errors.push(err('playInstanceId', 'missing_play_instance_id', '播放事件缺少 playInstanceId（ended/首次 playing 去重依据）'))
    }
    if (ev.type === EVENTS.TRACK_ENDED && typeof ev.natural !== 'boolean') {
      errors.push(err('natural', 'missing_natural_flag', 'track-ended 必须显式携带 natural 布尔标记；只有 natural=true 累计'))
    }
    if ([EVENTS.SEGUE_PLAYING, EVENTS.SEGUE_ENDED, EVENTS.SEGUE_FAILED].includes(ev.type) && !isNonEmptyString(ev.segueId)) {
      errors.push(err('segueId', 'missing_segue_id', '播报事件必须携带媒体身份 segueId'))
    }
    if (ev.type === EVENTS.PREPARE_RESULT) {
      if (!isNonEmptyString(ev.segueId)) errors.push(err('segueId', 'missing_segue_id', '准备结果缺少 segueId'))
      if (!isNonEmptyString(ev.transitionId)) errors.push(err('transitionId', 'missing_transition_id', '准备结果缺少 transitionId'))
      if (ev.state !== undefined && !JOB_STATES.includes(ev.state)) errors.push(err('state', 'invalid_job_state', '准备结果状态非法'))
    }
    return result(errors.length === 0, ev, errors)
  }

  function validateDecision(d) {
    const errors = []
    if (!d || typeof d !== 'object') return result(false, undefined, [err('', 'not_object', '决定必须是对象')])
    if (!DECISION_LIST.includes(d.type)) errors.push(err('type', 'invalid_decision_type', `未知决定类型：${d.type}`))
    if (!Number.isFinite(Number(d.at))) errors.push(err('at', 'missing_at', '决定缺少时间戳 at'))
    for (const k of ['segueId', 'transitionId']) {
      if (d[k] !== undefined && !isNonEmptyString(d[k])) errors.push(err(k, `invalid_${k}`, `${k} 必须是非空字符串`))
    }
    return result(errors.length === 0, d, errors)
  }

  /**
   * 播放实例登记：落实「暂停恢复复用 playInstanceId，重新开始同一条目则新建」。
   * markEnded/markPlaying 都只在实例有效且未消费时返回 true，供调用方去重。
   */
  function createPlayInstanceTracker() {
    let seq = 0
    const active = new Map() // itemId -> instance
    const byId = new Map() // playInstanceId -> instance
    function begin(itemId) {
      const prev = active.get(itemId)
      if (prev) prev.replaced = true
      seq += 1
      const inst = { id: makeId('pi'), itemId, playingSeen: false, endedConsumed: false, replaced: false }
      active.set(itemId, inst)
      byId.set(inst.id, inst)
      return inst.id
    }
    function resume(itemId) {
      const cur = active.get(itemId)
      if (cur && !cur.replaced && !cur.endedConsumed) return cur.id
      return begin(itemId)
    }
    function markPlaying(piid) {
      const inst = byId.get(piid)
      if (!inst || inst.replaced || inst.playingSeen) return false
      inst.playingSeen = true
      return true
    }
    function markEnded(piid) {
      const inst = byId.get(piid)
      if (!inst || inst.replaced || inst.endedConsumed) return false
      inst.endedConsumed = true
      return true
    }
    function current(itemId) {
      const inst = active.get(itemId)
      return inst && !inst.replaced ? inst.id : null
    }
    function clear() {
      active.clear()
      byId.clear()
    }
    return { begin, resume, markPlaying, markEnded, current, clear }
  }

  /* ---------- 样例（供 02–06 独立开发；全部虚构，不含真实凭据） ---------- */

  function clone(value) {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
  }

  const SAMPLE_TEMPLATES = {
    track: { trackId: 900002, name: '灯塔', artists: '另一位歌手', album: '示例专辑', durationMs: 210000 },
    trackA: { trackId: 900001, name: '夜航西飞', artists: '示例歌手', album: '示例专辑', durationMs: 245000 },
    prepareRequest: {
      sessionId: 'sess-demo-1',
      epoch: 7,
      transitionId: 'tr_demo_1',
      fromItemId: 'itn_demo_1',
      targetItemId: 'itn_demo_2',
      targetTrackId: 900002,
      brief: '深夜，安静一点',
    },
    transition: {
      transitionId: 'tr_demo_1',
      sessionId: 'sess-demo-1',
      epoch: 7,
      fromItemId: 'itn_demo_1',
      targetItemId: 'itn_demo_2',
      targetTrackId: 900002,
      state: 'open',
      createdAt: 1726459200000,
    },
    sourcedScript: {
      targetTrackId: 900002,
      targetItemId: 'itn_demo_2',
      transitionId: 'tr_demo_1',
      targetName: '灯塔',
      targetArtists: '另一位歌手',
      storyStatus: 'sourced',
      scriptText:
        '接下来这首《灯塔》来自「另一位歌手」。据乐迷在「独立音乐论坛」分享的说法，灵感来自一次深夜看海的经历；专辑介绍也提到录制只用了三天。来听听。',
      claims: [
        {
          id: 'c1',
          text: '创作灵感与一次深夜看海的经历有关（乐迷说法，未经证实）',
          kind: 'unverified_account',
          sourceIds: ['s1'],
          spokenAttribution: '据乐迷在「独立音乐论坛」分享的说法',
        },
        {
          id: 'c2',
          text: '专辑介绍提到录制只用了三天',
          kind: 'documented',
          sourceIds: ['s2'],
          spokenAttribution: '',
        },
      ],
      sources: [
        {
          id: 's1',
          url: 'https://forum.example.com/thread/12345',
          title: '《灯塔》创作背景讨论帖',
          publisherOrAuthor: '乐迷「听海的人」',
          evidence: '楼主称这首歌的灵感来自一次深夜看海的经历……',
          retrievedAt: '2026-09-16T10:00:00Z',
        },
        {
          id: 's2',
          url: 'https://music.example.com/reviews/lighthouse',
          title: '《灯塔》专辑介绍',
          publisherOrAuthor: '示例乐评',
          evidence: '专辑介绍写道，整张专辑的录制只用了三天。',
          retrievedAt: '2026-09-16T10:05:00Z',
        },
      ],
    },
    basicOnlyScript: {
      targetTrackId: 900002,
      targetItemId: 'itn_demo_2',
      transitionId: 'tr_demo_1',
      targetName: '灯塔',
      targetArtists: '另一位歌手',
      storyStatus: 'basic_only',
      scriptText: '接下来是「另一位歌手」的《灯塔》，一首适合深夜安静收听的歌。',
      claims: [],
      sources: [],
    },
  }

  const JOB_TEMPLATES = {
    preparingJob: () => ({
      segueId: 'sg_demo_1',
      state: 'preparing',
      stage: 'research',
      createdAt: 1726459200000,
      transition: clone(SAMPLE_TEMPLATES.transition),
    }),
    readyJob: () => ({
      segueId: 'sg_demo_1',
      state: 'ready',
      createdAt: 1726459200000,
      updatedAt: 1726459260000,
      transition: clone(SAMPLE_TEMPLATES.transition),
      script: clone(SAMPLE_TEMPLATES.sourcedScript),
      audio: { assetId: 'asset_demo_1', url: '/api/dj/audio/asset_demo_1', durationMs: 21300 },
    }),
    unavailableJob: () => ({
      segueId: 'sg_demo_2',
      state: 'unavailable',
      reason: 'voice_not_configured',
      message: '未配置 Fish 密钥或有效音色，本次继续音乐',
      createdAt: 1726459200000,
      transition: clone(SAMPLE_TEMPLATES.transition),
    }),
    staleJob: () => ({
      segueId: 'sg_demo_3',
      state: 'stale',
      reason: 'transition_closed',
      createdAt: 1726459200000,
      transition: clone(SAMPLE_TEMPLATES.transition),
    }),
  }

  const SCRIPT_INVALID_TEMPLATES = {
    emptyScript: (s) => ({ ...s, scriptText: '   ' }),
    invalidStoryStatus: (s) => ({ ...s, storyStatus: 'rumor' }),
    wrongKind: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, kind: 'rumor' } : c)) }),
    missingSourceReference: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, sourceIds: ['s999'] } : c)) }),
    claimWithoutSource: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, sourceIds: [] } : c)) }),
    missingSpokenAttribution: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, spokenAttribution: '' } : c)) }),
    attributionNotInScript: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, spokenAttribution: '据权威机构证实' } : c)) }),
    basicOnlyWithClaims: () => ({ ...clone(SAMPLE_TEMPLATES.basicOnlyScript), claims: clone(SAMPLE_TEMPLATES.sourcedScript.claims) }),
    basicOnlyWithSources: () => ({ ...clone(SAMPLE_TEMPLATES.basicOnlyScript), sources: clone(SAMPLE_TEMPLATES.sourcedScript.sources) }),
    overlongScript: (s) => ({ ...s, scriptText: '长'.repeat(141), claims: s.claims.map((c, i) => (i === 0 ? { ...c, spokenAttribution: '长' } : c)) }),
    badSourceUrl: (s) => ({ ...s, sources: s.sources.map((x, i) => (i === 0 ? { ...x, url: 'ftp://forum.example.com/x' } : x)) }),
    duplicateSourceId: (s) => ({ ...s, sources: s.sources.map((x, i) => (i === 1 ? { ...x, id: 's1' } : x)) }),
    evidenceTooLong: (s) => ({ ...s, sources: s.sources.map((x, i) => (i === 0 ? { ...x, evidence: '长'.repeat(401) } : x)) }),
    badRetrievedAt: (s) => ({ ...s, sources: s.sources.map((x, i) => (i === 0 ? { ...x, retrievedAt: 'not-a-date' } : x)) }),
    noClaims: (s) => ({ ...s, claims: [] }),
    noSources: (s) => ({ ...s, sources: [] }),
    missingTransitionId: (s) => ({ ...s, transitionId: '' }),
  }

  function buildInvalidSamples() {
    const sourced = () => clone(SAMPLE_TEMPLATES.sourcedScript)
    const scriptSamples = [
      ['empty_script', 'emptyScript', 'empty_script'],
      ['invalid_story_status', 'invalidStoryStatus', 'invalid_story_status'],
      ['invalid_claim_kind', 'wrongKind', 'invalid_claim_kind'],
      ['missing_source_reference', 'missingSourceReference', 'missing_source_reference'],
      ['claim_without_source', 'claimWithoutSource', 'claim_without_source'],
      ['missing_spoken_attribution', 'missingSpokenAttribution', 'missing_spoken_attribution'],
      ['attribution_missing_in_script', 'attributionNotInScript', 'attribution_missing_in_script'],
      ['basic_only_with_claims', 'basicOnlyWithClaims', 'basic_only_with_claims'],
      ['basic_only_with_sources', 'basicOnlyWithSources', 'basic_only_with_sources'],
      ['script_too_long', 'overlongScript', 'script_too_long'],
      ['invalid_source_url', 'badSourceUrl', 'invalid_source_url'],
      ['duplicate_source_id', 'duplicateSourceId', 'duplicate_source_id'],
      ['evidence_too_long', 'evidenceTooLong', 'evidence_too_long'],
      ['invalid_retrieved_at', 'badRetrievedAt', 'invalid_retrieved_at'],
      ['no_claims', 'noClaims', 'no_claims'],
      ['no_sources', 'noSources', 'no_sources'],
      ['missing_transition_id', 'missingTransitionId', 'missing_transition_id'],
    ]
    const samples = scriptSamples.map(([name, key, expectCode]) => ({
      name,
      kind: 'script',
      value: SCRIPT_INVALID_TEMPLATES[key](sourced()),
      expectCode,
    }))
    const base = SAMPLE_TEMPLATES.prepareRequest
    const prepareSamples = [
      ['prepare_missing_session', { sessionId: '' }, 'missing_session_id'],
      ['prepare_missing_transition', { transitionId: '' }, 'missing_transition_id'],
      ['prepare_same_from_target', { targetItemId: base.fromItemId }, 'same_from_and_target'],
      ['prepare_bad_track_id', { targetTrackId: 'x' }, 'invalid_target_track_id'],
      ['prepare_bad_epoch', { epoch: 'nan' }, 'invalid_epoch'],
      ['prepare_brief_too_long', { brief: 'x'.repeat(201) }, 'brief_too_long'],
    ]
    for (const [name, patch, expectCode] of prepareSamples) {
      samples.push({ name, kind: 'prepare', value: { ...clone(base), ...patch }, expectCode })
    }
    const jobSamples = [
      ['job_ready_missing_audio', (r) => ({ ...r.readyJob(), audio: undefined }), 'missing_audio'],
      [
        'job_external_audio_url',
        (r) => ({ ...r.readyJob(), audio: { assetId: 'a', url: 'https://cdn.example.com/x.mp3', durationMs: 20000 } }),
        'invalid_audio_url',
      ],
      [
        'job_zero_duration',
        (r) => ({ ...r.readyJob(), audio: { assetId: 'a', url: '/api/dj/audio/a', durationMs: 0 } }),
        'invalid_audio_duration',
      ],
      [
        'job_audio_too_long',
        (r) => ({ ...r.readyJob(), audio: { assetId: 'a', url: '/api/dj/audio/a', durationMs: 31000 } }),
        'audio_too_long',
      ],
      [
        'job_premature_result',
        (r) => ({ ...r.preparingJob(), audio: r.readyJob().audio }),
        'premature_result',
      ],
      ['job_bad_unavailable_reason', (r) => ({ ...r.unavailableJob(), reason: 'whatever' }), 'invalid_unavailable_reason'],
      ['job_bad_stale_reason', (r) => ({ ...r.staleJob(), reason: 'whatever' }), 'invalid_stale_reason'],
      ['job_bad_state', (r) => ({ ...r.preparingJob(), state: 'done' }), 'invalid_job_state'],
    ]
    for (const [name, build, expectCode] of jobSamples) {
      samples.push({ name, kind: 'job', value: build(JOB_TEMPLATES), expectCode })
    }
    // 跨目标：稿子为目标 A 生成，却声称属于目标 B 的任务
    const crossTarget = JOB_TEMPLATES.readyJob()
    crossTarget.script.targetTrackId = 777777
    samples.push({ name: 'job_cross_target_script', kind: 'job', value: crossTarget, expectCode: 'target_mismatch' })
    return samples
  }

  const SAMPLES = {
    /** 深拷贝取用，避免样例被调用方意外改坏。 */
    track: () => clone(SAMPLE_TEMPLATES.track),
    trackA: () => clone(SAMPLE_TEMPLATES.trackA),
    prepareRequest: () => clone(SAMPLE_TEMPLATES.prepareRequest),
    transition: () => clone(SAMPLE_TEMPLATES.transition),
    sourcedScript: () => clone(SAMPLE_TEMPLATES.sourcedScript),
    basicOnlyScript: () => clone(SAMPLE_TEMPLATES.basicOnlyScript),
    trackItem: () => makeTrackItem(SAMPLE_TEMPLATES.trackA),
    segueItem: () => makeSegueItem(clone(SAMPLE_TEMPLATES.transition)),
    preparingJob: JOB_TEMPLATES.preparingJob,
    readyJob: JOB_TEMPLATES.readyJob,
    unavailableJob: JOB_TEMPLATES.unavailableJob,
    staleJob: JOB_TEMPLATES.staleJob,
    invalidSamples: buildInvalidSamples,
  }

  return {
    // 常量与枚举
    PROGRAM_TYPES, STORY_STATUSES, CLAIM_KINDS, JOB_STATES, JOB_STAGES, TRANSITION_STATES,
    UNAVAILABLE_REASONS, STALE_REASONS, SCRIPT_FAILURE_CODES, TTS_FAILURE_CODES,
    EVENTS, DECISIONS, SCRIPT_BOUNDS, MAX_AUDIO_MS, MAX_CONTEXT_CHARS,
    SOURCE_MAX_EVIDENCE_CHARS, AUDIO_URL_PREFIX,
    // 工厂
    makeId, makeTrackItem, makeSegueItem, makeTransition, closeTransition,
    isTransitionOpen, transitionKey,
    // 校验
    validateTransition, validateQueueItem, validatePrepareRequest, jobMatchesPrepare,
    validateSources, validateScript, validateSegueJob, validateEvent, validateDecision,
    // 播放实例
    createPlayInstanceTracker,
    // 估算
    estimateSpeechSeconds,
    // 样例
    SAMPLES, clone,
  }
})
