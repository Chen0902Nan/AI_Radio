// 资料区（迁移自 index.html .library 区块 + app.js renderPlaylists/renderTracks）：
// 歌单侧栏 + 曲目列表；点击曲目播放；当前曲/失败/反馈标记按位置与 id 区分。
import { useEffect, useState, useRef } from 'react'
import { useRadio, useAppStore } from '../../app/radio-context'
import { api, type LibraryTrack } from '../../api/client'

interface PlaylistItem {
  id: number
  name: string
  trackCount: number
  kind: '自建' | '收藏'
}

export function Library() {
  const { playback, store, selectManual } = useRadio()
  const app = useAppStore()
  const snap = usePlaybackSnapshotSafe()
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([])
  const [tracks, setTracks] = useState<LibraryTrack[]>([])
  const sourceRequest = useRef(0)
  const [likedTracks, setLikedTracks] = useState<LibraryTrack[]>([])
  const [likedCount, setLikedCount] = useState('—')

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.library()
        if (!data.ok) throw new Error(String(data.message || `HTTP ${data.status}`))
        const liked = data.liked as { count: number; tracks: LibraryTrack[] }
        const pls = data.playlists as { created: PlaylistItem[]; collected: PlaylistItem[]; total: number }
        setLikedCount(String(liked.count))
        setTracks(liked.tracks)
        setLikedTracks(liked.tracks)
        setPlaylists([
          ...pls.created.map((p) => ({ ...p, kind: '自建' as const })),
          ...pls.collected.map((p) => ({ ...p, kind: '收藏' as const })),
        ])
        if (!playback.getSnapshot().userWantsPlayback && !store.get().preparingStart && playback.queue.length === 0) playback.replaceQueue(liked.tracks.map((t) => makeItem(t)))
      } catch (err) {
        setLikedCount('—')
        store.set({ status: { text: '读取音乐资料失败：' + (err as Error).message + '（请先到 /login 扫码）', cls: 'bad' } })
      }
    })()
    // 仅首载执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function openPlaylist(pl: PlaylistItem) {
    const request = ++sourceRequest.current
    selectManual([], `歌单：${pl.name}`)
    store.set({ status: { text: `正在读取歌单「${pl.name}」…`, cls: '' } })
    try {
      const d = await api.playlist(pl.id)
      if (request !== sourceRequest.current) return
      if (!d.ok) throw new Error(String(d.message || `HTTP ${d.status}`))
      const list = d.tracks as LibraryTrack[]
      setTracks(list)
      selectManual(list.map((t) => makeItem(t)), `歌单：${pl.name}`)
      store.set({ sourceLabel: `歌单：${pl.name}`, status: { text: `歌单「${pl.name}」读取到 ${d.returned}/${d.trackCount} 首（${d.via}）。`, cls: 'ok' } })
    } catch (err) {
      if (request !== sourceRequest.current) return
      store.set({ status: { text: '读取歌单失败：' + (err as Error).message, cls: 'bad' } })
    }
  }

  return (
    <section className="rounded-[14px] border border-line bg-panel px-5 py-[18px]">
      <div className="mb-3.5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-dim">音乐资料</h2>
        <span className="text-[13px] text-dim">红心歌曲 <b className="tabular-nums">{likedCount}</b></span>
      </div>
      <div className="grid grid-cols-[210px_1fr] gap-[18px]">
        <aside className="flex max-h-[420px] flex-col gap-1 overflow-auto">
          <button
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-[7px] text-left text-[13px] text-ink"
            onClick={() => { sourceRequest.current += 1; setTracks(likedTracks); selectManual(likedTracks.map(makeItem), '红心歌曲') }}
          >
            <span className="truncate">红心歌曲</span>
            <span className="flex-none text-[11px] tabular-nums text-dim">{likedCount}</span>
          </button>
          <div className="flex flex-col">
            {playlists.map((pl) => (
              <button
                key={pl.id}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-2.5 py-[7px] text-left text-[13px] text-ink hover:bg-panel-2"
                onClick={() => void openPlaylist(pl)}
                title={pl.name}
              >
                <span className="truncate">{pl.name}</span>
                <span className="flex-none text-[11px] tabular-nums text-dim">{pl.kind} {pl.trackCount}</span>
              </button>
            ))}
          </div>
        </aside>
        <div className="max-h-[420px] overflow-auto border-l border-line pl-3.5">
          {tracks.map((t, i) => {
            const isCurrent = snap.currentTrackId === t.id
            const feedback = app.feedback[String(t.id)]
            return (
              <div
                key={`${t.id}-${i}`}
                className={'grid cursor-pointer grid-cols-[26px_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-[7px] text-[13px] hover:bg-panel-2 ' + (isCurrent ? 'bg-[#20263a]' : '')}
                onClick={() => { sourceRequest.current += 1; selectManual(tracks.map(makeItem), '手动选歌'); void playback.play(i, { userGesture: true }) }}
                title={`${t.name} — ${t.artists}${t.album ? ' · ' + t.album : ''}`}
              >
                <span className="text-right text-[11px] tabular-nums text-[#616879]">{i + 1}</span>
                <span className={'truncate ' + (feedback === 'like' ? 'text-accent' : feedback === 'dislike' ? 'text-[#7b8296]' : 'text-ink')}>
                  {feedback === 'like' ? '♥ ' : feedback === 'dislike' ? '✕ ' : ''}{t.name}
                </span>
                <span className="text-[11px] tabular-nums text-[#616879]">{fmtMs(t.durationMs)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function usePlaybackSnapshotSafe() {
  const { playback } = useRadio()
  const [snap, setSnap] = useState(() => playback.getSnapshot())
  useEffect(() => playback.subscribe(() => setSnap(playback.getSnapshot())), [playback])
  return snap
}

function makeItem(t: LibraryTrack) {
  return { itemId: `itn_${t.id}_${Math.random().toString(36).slice(2, 8)}`, type: 'track' as const, trackId: t.id, name: t.name, artists: t.artists, album: t.album, durationMs: t.durationMs, auto: false, fromCodex: false, addedAt: Date.now() }
}

function fmtMs(ms: number): string {
  const sec = ms / 1000
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
