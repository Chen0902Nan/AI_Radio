// 应用装配入口（M1 骨架：仅证明构建链路可用；播放器 UI 在 M3 逐组件迁移）
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LoginPage } from '../features/login/LoginPage'
import '../styles/main.css'

// /login 单独成页（与旧版一致）；其余路径走主播放器
const isLogin = window.location.pathname === '/login'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isLogin ? <LoginPage /> : <App />}</StrictMode>,
)
