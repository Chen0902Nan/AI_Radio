// Codex 选歌面板（迁移自 index.html .codex 区块 + app.js requestPlan/renderCodexPicks）。
import { useEffect, useRef, useState } from 'react'
import { useRadio, useAppStore } from '../../app/radio-context'

export function CodexPanel() {
  const { store, sources } = useRadio()
  const app = useAppStore()
  const [brief, setBrief] = useState('')
  const [planStatus, setPlanStatus] = useState('用本机 Codex 订阅，从歌单内与歌单外候选中挑一批歌，接在当前播放之后。')
  const [planCls, setPlanCls] = useState('')
  const [pending, setPending] = useState(false)

  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])

  async function requestPlan() {
    setPending(true)
    setPlanStatus('Codex 正在选歌…（可能要十几秒）')
    const signal = lifetime.current?.signal
    const result = await sources.plan(brief, signal)
    if (signal?.aborted) return
    setPlanStatus(result.text)
    setPlanCls(result.cls)
    setPending(false)
  }

  return (
    <section className="mb-[22px] rounded-[14px] border border-line bg-panel px-5 py-[18px]">
      <div className="mb-3.5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-dim">Codex 选歌</h2>
        <button
          className="rounded-[9px] border border-line px-3 py-1.5 text-[13px] text-ink hover:border-[#3c4254]"
          onClick={() => store.set({ codexPicks: [] })}
        >
          清除 Codex 队列
        </button>
      </div>
      <div className="mb-3 flex gap-2.5">
        <input
          className="min-w-0 flex-1 rounded-[9px] border border-line bg-panel-2 px-3 py-2 text-ink placeholder:text-[#6f7688]"
          placeholder="想听什么场景？例如：深夜安静、适合一个人听"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        <button
          className="rounded-[9px] border border-accent bg-accent px-4 py-2 font-semibold text-[#0e0f13] hover:border-[#3c4254] disabled:opacity-45"
          disabled={pending}
          onClick={() => void requestPlan()}
        >
          让 Codex 选歌
        </button>
      </div>
      <div className={'min-h-5 border-l-[3px] border-line py-1.5 pl-2.5 text-[13px] text-dim ' + (planCls === 'ok' ? 'border-ok text-ok' : planCls === 'bad' ? 'border-bad text-bad' : '')}>
        {planStatus}
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {app.codexPicks.map((p, i) => (
          <div
            key={`${p.id}-${i}`}
            className="grid cursor-pointer grid-cols-[22px_1fr] items-baseline gap-2.5 rounded-[9px] border border-line px-2.5 py-2 hover:bg-panel-2"
            onClick={() => void sources.playManual(p.id)}
          >
            <span className="text-right text-[11px] tabular-nums text-[#616879]">{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-[13px] text-ink">{p.name} — {p.reason ? '' : ''}</span>
              <span className="mt-0.5 block text-xs text-dim">{p.reason}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
