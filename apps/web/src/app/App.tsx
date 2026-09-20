import { useEffect, useState } from 'react'
import { RadioProvider, useRadio, useAppStore } from './radio-context'
import { Player } from '../features/player/Player'
import { CodexPanel } from '../features/codex/CodexPanel'
import { DjPanel } from '../features/dj/DjPanel'
import { Library } from '../features/library/Library'
import { api } from '../api/client'

function Header() {
  const { store } = useRadio()
  const app = useAppStore()
  const [account, setAccount] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.library()
        const acc = data.ok ? data.account : null
        if (data.ok && acc) {
          setAccount(`${acc.nickname} · uid ${acc.userId}`)
          store.set({ status: { text: store.get().status.text, cls: 'ok' } })
        } else {
          setAccount(null)
        }
      } catch (_) {
        setAccount(null)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <header className="mb-4 flex items-baseline justify-between gap-4">
      <h1 className="mb-0 text-xl font-semibold">
        个人电台<span className="ml-2.5 rounded-full border border-line px-2 py-0.5 align-middle text-[11px] font-medium text-dim">音乐链路验证</span>
      </h1>
      {account ? (
        <div className="text-[13px] text-ok">{account}</div>
      ) : (
        <div className="text-[13px] text-warn">
          未登录 · <a href="/login" className="text-inherit underline">去扫码登录</a>
        </div>
      )}
    </header>
  )
}

function AppInner() {
  return (
    <main className="mx-auto max-w-[960px] px-5 pb-[60px] pt-7">
      <Header />
      <Player />
      <CodexPanel />
      <DjPanel />
      <Library />
    </main>
  )
}

export function App() {
  return (
    <RadioProvider>
      <AppInner />
    </RadioProvider>
  )
}
