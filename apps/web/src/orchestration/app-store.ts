import type { SegueScript } from '@radio/contracts'

export interface AppStore {
  preparingStart: boolean
  queueMode: 'radio' | 'manual'
  radioPrepared: boolean
  status: { text: string; cls: string }
  prepStatus: { text: string; cls: string }
  djStatus: { text: string; cls: string }
  sessionId: string | null
  adjustments: Record<string, string>
  playId: number | null
  feedback: Record<string, 'like' | 'dislike'>
  feedbackNames: Record<string, string>
  codexPicks: Array<{ id: number; name: string; reason: string }>
  sourceLabel: string
  awaitingRefill: boolean
  eventsConnected: boolean
  settings: Record<string, string>
  djScript: SegueScript | null
  djVoice: { ready: boolean; code: string | null; message: string; voiceReferenceId: string | null } | null
}

const initialStore: AppStore = {
  preparingStart: false,
  queueMode: 'radio',
  radioPrepared: false,
  status: { text: '先登录并读取资料，然后点击开播。', cls: '' },
  prepStatus: { text: '后台补歌：待播不足时会自动准备下一批，不打断当前歌曲。', cls: 'prep' },
  djStatus: { text: '', cls: 'prep' },
  sessionId: null,
  adjustments: {},
  playId: null,
  feedback: {},
  feedbackNames: {},
  codexPicks: [],
  sourceLabel: '红心歌曲',
  awaitingRefill: false,
  eventsConnected: false,
  settings: {},
  djScript: null,
  djVoice: null,
}

export function createAppStore() {
  let state: AppStore = initialStore
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(patch: Partial<AppStore>) {
      state = { ...state, ...patch }
      for (const l of listeners) l()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}
