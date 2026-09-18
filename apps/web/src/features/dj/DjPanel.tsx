// DJ 面板（迁移自 index.html .dj 区块 + app.js DJ 设置/试听逻辑）：
// 开关、间隔、串场展示（完整文案 + 可点击来源）、音色试听与保存；错误提示与禁用态保留。
import { useEffect, useState } from 'react'
import { useRadio, useAppStore } from '../../app/radio-context'
import { api } from '../../api/client'

export function DjPanel() {
  const { playback, segue, store } = useRadio()
  const app = useAppStore()
  const [enabled, setEnabled] = useState(true)
  const [interval, setIntervalValue] = useState('4')
  const [previewVoice, setPreviewVoice] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewStatus, setPreviewStatus] = useState<string | null>(null)
  const [canSave, setCanSave] = useState(false)

  useEffect(() => {
    if (app.settings.djEnabled !== undefined) setEnabled(app.settings.djEnabled !== 'false')
    if (['3', '4', '5'].includes(app.settings.djIntervalTracks)) setIntervalValue(app.settings.djIntervalTracks)
  }, [app.settings])

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.settings()
        const s = (data.settings ?? {}) as Record<string, string>
        const voice = data.djVoice as { ready: boolean; code: string | null; message: string; voiceReferenceId: string | null } | undefined
        store.set({ djVoice: voice ?? null })
        const savedVoice = voice?.voiceReferenceId || s.djVoiceReferenceId
        if (savedVoice && !previewVoice.trim()) setPreviewVoice(savedVoice)
        setEnabled(s.djEnabled !== 'false')
        if (['3', '4', '5'].includes(String(s.djIntervalTracks))) setIntervalValue(String(s.djIntervalTracks))
        // 初始配置同步到串场控制器（旧 applyDjConfig 语义）
        segue.setConfig({
          djEnabled: s.djEnabled !== 'false',
          djIntervalTracks: Number(s.djIntervalTracks) || 4,
        })
      } catch (_) {}
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function saveSetting(key: string, value: unknown): Promise<boolean> {
    try {
      const data = await api.saveSetting(key, value)
      if (!data.ok) throw new Error(String(data.message || `HTTP ${data.status}`))
      store.set({ djVoice: (data.djVoice as never) ?? store.get().djVoice })
      return true
    } catch (err) {
      setPreviewStatus('设置保存失败：' + (err as Error).message)
      return false
    }
  }

  function applyConfig(patch: { djEnabled?: boolean; djIntervalTracks?: number; voiceConfigUpdated?: boolean }) {
    segue.setConfig(patch)
  }

  async function preview() {
    if (store.get().sessionId) {
      setPreviewStatus('停止收听后才能试听音色，避免打断节目。')
      return
    }
    const referenceId = previewVoice.trim()
    if (!referenceId) {
      setPreviewStatus('先填写要试听的音色 reference_id。')
      return
    }
    setPreviewStatus('正在合成试听…')
    try {
      const data = await api.djPreview(referenceId)
      if (!data.ok) {
        setPreviewStatus(`试听失败（${data.code || data.status}）：${data.message || ''}`)
        return
      }
      // 合成期间用户可能已经开播：迟到结果不能替换媒体
      if (store.get().sessionId) {
        setPreviewStatus('试听结果已过期，未打断当前收听。')
        return
      }
      const audioUrl = (data.audio as { url: string }).url
      const durationMs = (data.audio as { durationMs: number }).durationMs
      const ok = await playback.startPreview(audioUrl)
      if (ok) {
        setPreviewStatus(`试听播放中（约 ${(durationMs / 1000).toFixed(1)} 秒）。满意就点「设为正式音色」。`)
        setCanSave(true)
      }
    } catch (err) {
      setPreviewStatus('试听播放失败：' + (err as Error).message)
    }
  }

  async function saveChosen() {
    const referenceId = previewVoice.trim()
    if (!referenceId) return
    if (!(await saveSetting('djVoiceReferenceId', referenceId))) return
    setCanSave(false)
    applyConfig({ voiceConfigUpdated: true })
    setPreviewStatus(`已把 ${referenceId} 设为正式音色，之后的串场都会用它。`)
  }

  return (
    <section className="mb-[22px] rounded-[14px] border border-line bg-panel px-5 py-[18px]">
      <div className="mb-3.5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-dim">DJ 串场</h2>
        <span className="flex items-center gap-3.5 text-xs text-dim">
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); void saveSetting('djEnabled', e.target.checked ? 'true' : 'false'); applyConfig({ djEnabled: e.target.checked }) }} />
            开启 DJ
          </label>
          <label className="inline-flex items-center gap-1.5">
            每
            <select
              className="rounded-md border border-line bg-panel-2 px-1.5 py-0.5 text-xs text-ink"
              value={interval}
              onChange={(e) => { setIntervalValue(e.target.value); void saveSetting('djIntervalTracks', e.target.value); applyConfig({ djIntervalTracks: Number(e.target.value) }) }}
            >
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
            </select>
            首一次
          </label>
        </span>
      </div>
      <div className="min-h-5 border-l-[3px] border-line py-1.5 pl-2.5 text-xs text-[#7b8296]">
        {app.djVoice && !app.djVoice.ready ? `${app.djVoice.message} 当前继续纯音乐。` : 'DJ 串场：歌曲之间用有出处的资料介绍下一首，语音不可用时继续纯音乐。'}
      </div>

      <p className="mt-2 text-xs text-dim" role="status">{app.djStatus.text}</p>
      {app.djScript && (
        <div className="mt-3 rounded-lg border border-line p-3 text-sm text-ink">
          <p className="whitespace-pre-wrap">{app.djScript.scriptText}</p>
          {app.djScript.storyStatus === 'basic_only' && <p className="mt-2 text-xs text-dim">本段为基础介绍，没有采用歌曲故事。</p>}
          <ul className="mt-2 space-y-1 text-xs text-dim">
            {app.djScript.sources.filter((s) => /^https?:\/\//i.test(s.url)).map((s) => (
              <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer" className="text-accent underline">{s.title}</a>{s.publisherOrAuthor ? ` · ${s.publisherOrAuthor}` : ''}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 音色试听（停止收听后才能用） */}
      <div className="mt-3 flex items-center gap-2">
        <input
          className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-2.5 py-[7px] text-[13px] text-ink placeholder:text-[#6f7688]"
          placeholder="音色 reference_id（试听用，选定后保存为正式音色）"
          value={previewVoice}
          onChange={(e) => setPreviewVoice(e.target.value)}
        />
        <button
          className="rounded-[9px] border border-line px-3 py-1.5 text-[13px] text-ink hover:border-[#3c4254] disabled:opacity-45"
          disabled={!canSave}
          onClick={() => void saveChosen()}
        >
          设为正式音色
        </button>
        <button
          className="rounded-[9px] border border-line px-3 py-1.5 text-[13px] text-ink hover:border-[#3c4254]"
          onClick={() => void preview()}
        >
          试听
        </button>
      </div>
      {previewing && <div className="mt-2 text-xs text-dim">试听播放中…</div>}
      {previewStatus && <div className={'mt-2 text-xs ' + (previewStatus.startsWith('试听失败') || previewStatus.startsWith('设置保存失败') ? 'text-bad' : 'text-dim')}>{previewStatus}</div>}
    </section>
  )
}
