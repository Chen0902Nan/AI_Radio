// 播放器区（迁移自 public/index.html .player 区块 + app.js 播放控制）：
// 布局与交互保持旧版；组件只订阅快照与发命令（useSyncExternalStore + controller 命令）。
import { useRadio, usePlaybackSnapshot, useAppStore } from '../../app/radio-context'
import { api } from '../../api/client'

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function Player() {
  const { playback, store, refill, segue, startListening, stopListening } = useRadio()
  const snap = usePlaybackSnapshot()
  const app = useAppStore()

  const hasQueue = snap.queueLength > 0
  const label = app.preparingStart ? '暂停' : snap.resolving || (snap.userWantsPlayback && !snap.paused) ? '暂停' : app.sessionId ? '继续' : '开播'

  async function onPlay() {
    // 正在解析也允许暂停：取消在途请求
    if (app.preparingStart || snap.resolving || (snap.userWantsPlayback && !snap.paused)) {
      playback.pause()
      store.set({ status: { text: '已暂停。', cls: '' } })
      return
    }
    await startListening()
  }


  return (
    <section data-radio-observation={JSON.stringify({ queueLength: snap.queueLength, index: snap.index, sessionId: app.sessionId, awaitingRefill: app.awaitingRefill, userWantsPlayback: snap.userWantsPlayback, refill: refill.snapshot(), segue: segue.snapshot() })} className="rounded-[14px] border border-line bg-panel p-5 mb-[22px]">
      {/* 当前播放 */}
      <div className="flex items-center gap-3.5 mb-4">
        <div className="grid h-14 w-14 flex-none place-items-center rounded-[10px] bg-panel-2 text-2xl text-dim">♪</div>
        <div className="min-w-0">
          <div className="truncate text-[17px] font-semibold text-ink">{snap.currentTitle ?? '未在播放'}</div>
          <div className="text-[13px] text-dim">—</div>
          <div className="text-xs text-[#6f7688]"></div>
        </div>
      </div>

      {/* 进度条 */}
      <div className="flex items-center gap-2.5 text-xs tabular-nums text-dim">
        <span>{fmt(snap.currentTime)}</span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-panel-2">
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: snap.duration > 0 ? (snap.currentTime / snap.duration) * 100 + '%' : '0' }}
          />
        </div>
        <span>{fmt(snap.duration)}</span>
      </div>

      {/* 控制 */}
      <div className="mt-4 flex items-center gap-2.5">
        <button
          className="min-w-[88px] rounded-[9px] border border-accent bg-accent px-4 py-2 font-semibold text-[#0e0f13] hover:border-[#3c4254] disabled:opacity-45"
          onClick={onPlay}
        >
          {label}
        </button>
        <button
          className="rounded-[9px] border border-line bg-panel-2 px-4 py-2 text-ink hover:border-[#3c4254] disabled:opacity-45"
          disabled={!hasQueue || app.preparingStart}
          onClick={() => void playback.skipTo(snap.index + 1)}
        >
          下一首
        </button>
        <button
          className="rounded-[9px] border border-line bg-panel-2 px-4 py-2 text-ink hover:border-[#3c4254] disabled:opacity-45"
          disabled={!app.sessionId && !app.preparingStart}
          onClick={() => void stopListening()}
        >
          停止
        </button>
        <span className="ml-auto text-xs tabular-nums text-dim">
          {hasQueue ? `${snap.index + 1} / ${snap.queueLength} · ${app.sourceLabel}` : ''}
        </span>
      </div>

      {/* 反馈 */}
      <FeedbackButtons />

      <div className={'mt-3.5 min-h-5 border-l-[3px] border-line py-1.5 pl-2.5 text-[13px] text-dim ' + statusColor(app.status.cls)}>
        {app.status.text}
      </div>
      <div className={'mt-2 min-h-5 border-l-[3px] border-line py-1.5 pl-2.5 text-xs text-[#7b8296] ' + statusColor(app.prepStatus.cls)}>
        {app.prepStatus.text}
      </div>
    </section>
  )
}

function FeedbackButtons() {
  const { playback, store } = useRadio()
  const snap = usePlaybackSnapshot()
  const app = useAppStore()
  const current = snap.currentTrackId
  const sentiment = current ? app.feedback[String(current)] ?? null : null
  const duringSegue = snap.currentKind === 'segue'

  async function save(sentiment: 'like' | 'dislike') {
    const item = playback.queue[snap.index]
    if (!item) return
    try {
      if (store.get().feedback[String(item.trackId)] === sentiment) {
        const revoked = await api.revokeFeedback(item.trackId)
        if (!revoked.ok) throw new Error(String(revoked.message || '撤销失败'))
        const feedback = {...store.get().feedback}; delete feedback[String(item.trackId)]
        store.set({feedback, status: {text: `已撤销对「${item.name}」的反馈`, cls: 'ok'}})
        return
      }
      const data = await api.addFeedback({ trackId: item.trackId, trackName: item.name, artists: item.artists, sentiment })
      if (!data.ok) throw new Error(String(data.message || `HTTP ${data.status}`))
      store.set({ feedback: { ...store.get().feedback, [String(item.trackId)]: sentiment }, feedbackNames: {...store.get().feedbackNames, [String(item.trackId)]: item.name} })
      store.set({ status: { text: sentiment === 'like' ? `已记住：喜欢「${item.name}」` : `已记住：不喜欢「${item.name}」`, cls: 'ok' } })
    } catch (err) {
      store.set({ status: { text: '反馈保存失败：' + (err as Error).message, cls: 'bad' } })
    }
  }

  return (
    <>
    <div className="mt-2.5 flex items-center gap-2.5">
      <span className="text-xs text-[#6f7688]">对这首歌：</span>
      <button
        className={'rounded-[9px] border border-line bg-panel-2 px-4 py-2 text-ink hover:border-[#3c4254] disabled:opacity-45 ' + (sentiment === 'like' ? 'border-accent bg-accent font-semibold text-[#0e0f13]' : '')}
        disabled={duringSegue}
        onClick={() => void save('like')}
      >
        {sentiment === 'like' ? '撤销喜欢' : '喜欢'}
      </button>
      <button
        className={'rounded-[9px] border border-line bg-panel-2 px-4 py-2 text-ink hover:border-[#3c4254] disabled:opacity-45 ' + (sentiment === 'dislike' ? 'border-accent bg-accent font-semibold text-[#0e0f13]' : '')}
        disabled={duringSegue}
        onClick={() => void save('dislike')}
      >
        {sentiment === 'dislike' ? '撤销不喜欢' : '不喜欢'}
      </button>
      <span className="ml-auto text-xs text-dim">
        {app.sessionId ? `收听会话 ${app.sessionId}` : '未开播'}
      </span>
    </div>
    {Object.entries(app.feedback).some(([,value]) => value === 'dislike') && <div className="mt-2 flex flex-wrap gap-2 text-xs text-dim">
      <span>已排除的歌曲：</span>
      {Object.entries(app.feedback).filter(([,value]) => value === 'dislike').map(([id]) => <button key={id}
        className="rounded border border-line px-2 py-1"
        onClick={async () => {
          try {
            const result = await api.revokeFeedback(Number(id))
            if (!result.ok) throw new Error('撤销失败')
            const feedback = {...store.get().feedback}; delete feedback[id]
            store.set({feedback, status: {text: `已恢复推荐「${app.feedbackNames[id] || '这首歌'}」`, cls: 'ok'}})
          } catch (_) { store.set({status: {text: '撤销失败，请重试。', cls: 'bad'}}) }
        }}>恢复推荐「{app.feedbackNames[id] || '这首歌'}」</button>)}
    </div>}
    </>
  )
}

function statusColor(cls: string): string {
  if (cls.includes('ok') || cls.includes('playing')) return 'border-ok text-ok'
  if (cls.includes('warn')) return 'border-warn text-warn'
  if (cls.includes('bad')) return 'border-bad text-bad'
  return 'border-line text-dim'
}
