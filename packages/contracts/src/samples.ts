import { type Claim, type Source, type SegueScript } from './models.js'
import { makeTrackItem, makeSegueItem } from './identity.js'

export function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T)
}

const SAMPLE_TEMPLATES = {
  track: { trackId: 900002, name: '灯塔', artists: '另一位歌手', album: '示例专辑', durationMs: 210000 },
  trackA: { trackId: 900001, name: '夜航西飞', artists: '示例歌手', album: '示例专辑', durationMs: 245000 },
  prepareRequest: {
    sessionId: 'sess-demo-1',
    epoch: 7,
    transitionSeq: 1,
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
    transitionSeq: 1,
    fromItemId: 'itn_demo_1',
    targetItemId: 'itn_demo_2',
    targetTrackId: 900002,
    state: 'open' as const,
    createdAt: 1726459200000,
  },
  sourcedScript: {
    targetTrackId: 900002,
    targetItemId: 'itn_demo_2',
    transitionId: 'tr_demo_1',
    targetName: '灯塔',
    targetArtists: '另一位歌手',
    storyStatus: 'sourced' as const,
    scriptText:
      '接下来这首《灯塔》来自「另一位歌手」。据乐迷在「独立音乐论坛」分享的说法，灵感来自一次深夜看海的经历；专辑介绍也提到录制只用了三天。来听听。',
    claims: [
      {
        id: 'c1',
        text: '创作灵感与一次深夜看海的经历有关（乐迷说法，未经证实）',
        kind: 'unverified_account' as const,
        sourceIds: ['s1'],
        spokenAttribution: '据乐迷在「独立音乐论坛」分享的说法',
      },
      {
        id: 'c2',
        text: '专辑介绍提到录制只用了三天',
        kind: 'documented' as const,
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
    storyStatus: 'basic_only' as const,
    scriptText: '接下来是「另一位歌手」的《灯塔》，一首适合深夜安静收听的歌。',
    claims: [] as Claim[],
    sources: [] as Source[],
  },
}

const JOB_TEMPLATES = {
  preparingJob: () => ({
    segueId: 'sg_demo_1',
    state: 'preparing' as const,
    stage: 'research' as const,
    createdAt: 1726459200000,
    transition: clone(SAMPLE_TEMPLATES.transition),
  }),
  readyJob: () => ({
    segueId: 'sg_demo_1',
    state: 'ready' as const,
    createdAt: 1726459200000,
    updatedAt: 1726459260000,
    transition: clone(SAMPLE_TEMPLATES.transition),
    script: clone(SAMPLE_TEMPLATES.sourcedScript),
    audio: { assetId: 'asset_demo_1', url: '/api/dj/audio/asset_demo_1', durationMs: 21300, bytes: 50000 },
  }),
  unavailableJob: () => ({
    segueId: 'sg_demo_2',
    state: 'unavailable' as const,
    reason: 'voice_not_configured',
    message: '未配置 Fish 密钥或有效音色，本次继续音乐',
    createdAt: 1726459200000,
    transition: clone(SAMPLE_TEMPLATES.transition),
  }),
  staleJob: () => ({
    segueId: 'sg_demo_3',
    state: 'stale' as const,
    reason: 'transition_closed',
    createdAt: 1726459200000,
    transition: clone(SAMPLE_TEMPLATES.transition),
  }),
}

const SCRIPT_INVALID_TEMPLATES: Record<string, (s: SegueScript) => Record<string, unknown>> = {
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

export interface InvalidSample {
  name: string
  kind: 'script' | 'prepare' | 'job'
  value: unknown
  expectCode: string
}

function buildInvalidSamples(): InvalidSample[] {
  const sourced = () => clone(SAMPLE_TEMPLATES.sourcedScript)
  const scriptSamples: Array<[string, string, string]> = [
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
  const samples: InvalidSample[] = scriptSamples.map(([name, key, expectCode]) => ({
    name,
    kind: 'script',
    value: SCRIPT_INVALID_TEMPLATES[key](sourced()),
    expectCode,
  }))
  const base = SAMPLE_TEMPLATES.prepareRequest
  const prepareSamples: Array<[string, Record<string, unknown>, string]> = [
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
  const jobSamples: Array<[string, (r: typeof JOB_TEMPLATES) => Record<string, unknown>, string]> = [
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

export const SAMPLES = {
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
