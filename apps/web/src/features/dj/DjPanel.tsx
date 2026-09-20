// DJ 面板（迁移自 index.html .dj 区块 + app.js DJ 设置/试听逻辑）：
// 开关、间隔、串场展示（完整文案 + 可点击来源）、音色试听与保存；错误提示与禁用态保留。
import { useEffect, useSyncExternalStore } from 'react'
import { useRadio, useAppStore } from '../../app/radio-context'

export function DjPanel() {
  const { settings, preview } = useRadio()
  const app = useAppStore()
  const config = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot)
  const audition = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot)
  const enabled = config.settings.djEnabled !== 'false'
  const interval = config.settings.djIntervalTracks || '4'
  useEffect(() => {
    preview.initialize(config.djVoice?.voiceReferenceId || config.settings.djVoiceReferenceId || '')
  }, [preview, config.djVoice, config.settings.djVoiceReferenceId])
  useEffect(() => preview.stop, [preview])

  return (
    <section className="mb-[22px] rounded-[14px] border border-line bg-panel px-5 py-[18px]">
      <div className="mb-3.5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-dim">DJ 串场</h2>
        <span className="flex items-center gap-3.5 text-xs text-dim">
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={enabled} onChange={(e) => { void settings.save('djEnabled', e.target.checked ? 'true' : 'false') }} />
            开启 DJ
          </label>
          <label className="inline-flex items-center gap-1.5">
            每
            <select
              className="rounded-md border border-line bg-panel-2 px-1.5 py-0.5 text-xs text-ink"
              value={interval}
              onChange={(e) => { void settings.save('djIntervalTracks', e.target.value) }}
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
          value={audition.voice}
          onChange={(e) => preview.edit(e.target.value)}
        />
        <button
          className="rounded-[9px] border border-line px-3 py-1.5 text-[13px] text-ink hover:border-[#3c4254] disabled:opacity-45"
          disabled={!audition.canSave}
          onClick={() => void preview.saveChosen()}
        >
          设为正式音色
        </button>
        <button
          className="rounded-[9px] border border-line px-3 py-1.5 text-[13px] text-ink hover:border-[#3c4254]"
          onClick={() => void preview.preview()}
        >
          试听
        </button>
      </div>
      <button className="mt-2 text-xs text-dim" onClick={preview.stop}>停止试听</button>
      {config.error && <div role="alert" className="mt-2 text-xs text-bad">{config.error}</div>}
      {audition.status && <div className="mt-2 text-xs text-dim">{audition.status}</div>}
    </section>
  )
}
