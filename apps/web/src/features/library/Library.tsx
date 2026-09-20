// 资料区（迁移自 index.html .library 区块 + app.js renderPlaylists/renderTracks）：
// 歌单侧栏 + 曲目列表；点击曲目播放；当前曲/失败/反馈标记按位置与 id 区分。
import { useEffect, useState, useRef } from 'react'
import { useRadio, useAppStore } from '../../app/radio-context'
import { type LibraryTrack } from '../../api/client'

interface PlaylistItem {
  id: number
  name: string
  trackCount: number
  kind: '自建' | '收藏'
}

export function Library() {
  const { playback, selectManual, sources } = useRadio()
  const app = useAppStore()
  const snap = usePlaybackSnapshotSafe()
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([])
  const [tracks, setTracks] = useState<LibraryTrack[]>([])
  const [likedTracks, setLikedTracks] = useState<LibraryTrack[]>([])
  const [likedCount, setLikedCount] = useState('—')

  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void sources.library(controller.signal).then(data => {
      if (!data || controller.signal.aborted) return
      setLikedCount(String(data.liked.count))
      if (data.current) setTracks(data.liked.tracks)
      setLikedTracks(data.liked.tracks)
      setPlaylists([
        ...data.playlists.created.map(p => ({ ...p, kind: '自建' as const })),
        ...data.playlists.collected.map(p => ({ ...p, kind: '收藏' as const })),
      ])
    })
    return () => controller.abort()
  }, [sources])

  async function openPlaylist(pl: PlaylistItem) {
    const signal = lifetime.current?.signal
    const tracks = await sources.playlist(pl.id, pl.name, signal)
    if (tracks && !signal?.aborted) setTracks(tracks)
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
            onClick={() => { setTracks(likedTracks); selectManual(likedTracks.map(makeItem), '红心歌曲') }}
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
                onClick={() => { selectManual(tracks.map(makeItem), '手动选歌'); void playback.play(i, { userGesture: true }) }}
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
