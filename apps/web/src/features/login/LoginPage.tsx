// 扫码登录页（迁移自 public/login.html + login.js）：只在用户本人操作时使用，
// 凭据由服务端保存。二维码约 5 分钟失效，提前换一张避免扫到过期码。
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { LoginLifecycle } from '../../orchestration/login-lifecycle'

async function loginRequest(path: string, signal: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(path, { signal })
  } catch (_) {
    throw new Error('无法连接登录服务，请检查后端服务是否已启动，然后重试。')
  }
  if (!res.ok) {
    if ([502, 503, 504].includes(res.status)) {
      throw new Error(`无法连接登录服务（HTTP ${res.status}），请检查后端服务是否已启动，然后重试。`)
    }
    throw new Error(`登录请求失败（HTTP ${res.status}），请稍后重试。`)
  }
  try {
    return await res.json()
  } catch (_) {
    throw new Error('登录服务返回的数据不完整，请稍后重试。')
  }
}

export function LoginPage() {
  const lifecycle = useMemo(() => new LoginLifecycle({
    request: loginRequest,
    navigate: () => { window.location.href = '/' },
  }), [])
  const { qrImg, status } = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot)
  useEffect(() => {
    void lifecycle.start()
    return lifecycle.dispose
  }, [lifecycle])

  return (
    <main className="mx-auto max-w-[520px] px-5 pb-[60px] pt-7">
      <h1 className="mb-4 text-xl font-semibold">用网易云音乐 App 扫码登录</h1>
      <p className="text-[13px] leading-relaxed text-dim">
        二维码只在本机使用。登录 cookie 保存在项目的 <code className="rounded bg-panel-2 px-1 py-0.5 text-xs">data/session.json</code>，
        不会发送到任何第三方，页面也不会拿到它。本应用只读取资料与播放地址，不会修改你的红心或歌单。
      </p>
      <div className="mx-auto my-[18px] w-[236px] rounded-xl bg-white p-3.5">
        {qrImg && <img src={qrImg} alt="登录二维码" className="block w-full" />}
      </div>
      <div className="min-h-5 border-l-[3px] border-line py-1.5 pl-2.5 text-[13px] text-dim">{status}</div>
      <button
        className="mt-3 rounded-[9px] border border-line px-3 py-1.5 text-[13px] text-ink hover:border-[#3c4254]"
        onClick={() => void lifecycle.start('手动刷新')}
      >
        {qrImg ? '二维码过期了？点这里换一张' : '重新获取二维码'}
      </button>
      <a href="/" className="mt-[18px] inline-block text-[13px] text-accent no-underline hover:underline">
        ← 返回播放器
      </a>
    </main>
  )
}
