# M3 验证报告：React + Tailwind + 独立 PlaybackController

日期：2026-09-17。基线：M2 完成后的工作区。

## 1. 迁移内容

| 层 | 新位置 | 说明 |
| --- | --- | --- |
| 媒体执行 | `apps/web/src/playback/playback-controller.ts` | 单一 audio、playToken 代次、媒体归属（mediaPlayInstance）、playInstanceTracker、试听/串场/预览共用出口、dispose 生命周期 |
| 应用装配 | `apps/web/src/app/radio-context.tsx` | RadioProvider（Context + 模块级单例）；StrictMode 双重 mount 复用同一 PlaybackController，不重复绑定媒体事件 |
| UI 组件 | `src/features/{player,codex,dj,library}` | 布局与交互对齐旧版；组件只订阅快照 + 发命令；Tailwind 类完整枚举 |
| 样式 | `src/styles/main.css` | Tailwind v4 `@theme`；旧 style.css 的 CSS 变量映射为主题值（--color-panel 等） |
| 静态服务 | `apps/api/src/http/static.controller.ts` | 生产优先服务 `apps/web/dist`，不存在时回退旧 `public/`（回滚入口） |

控制器/补歌复用决定：`public/orchestrator.js` 与 `public/segue-controller.js` 的 JS 模块在 M3 保持原样复用（已通过 22+ 项单元验证），M3 的移植焦点是媒体执行层与 UI；这两个控制器的 TS 化并入 M4/M5 的收尾项，不与 React 装配混在同一改动。

## 2. 已执行验证

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| PlaybackController 行为回归 | `apps/web/test/playback-controller.test.mjs`（假 audio，Node 确定性） | 9/9：媒体归属、切歌旧事件过滤、加载中暂停丢弃迟到结果、同曲重播实例区分、失败分类与 3 次上限、试听身份独立、DJ 事件隔离、dispose、订阅协议 |
| web/api/contracts 三包 typecheck | `npm run typecheck` | 0 错误 |
| React 页面加载（真实登录态） | 无头 Chrome → Nest(8794) 服务 `apps/web/dist` | 完整渲染：账号区、播放器、Codex、DJ、曲库 456 首；**无 pageerror/console error** |
| 实际媒体进度 | 点击开播后读 `document.querySelector('audio')` | `currentTime=6.49`、`paused=false`、src 为同源 `/api/audio/65536`——观察的是真实媒体进度，不是歌名/状态文案 |
| 停止行为 | 点击停止后读 audio | `paused=true` |
| 单 audio 实例 | DOM 审计 | `document.querySelectorAll('audio').length === 1` |
| 全套回归 | `npm test` + web playback 测试 | 122 + 9 = 131 全绿 |

## 3. 边界与未完成

- 补歌/串场控制器的 React 接线（refill.onBatch→队列追加、segue 决定→播放执行）在 radio-context 中为骨架占位（`onBatch: () => []`、pendingCount 返回 0）：M3 范围是媒体层与 UI 迁移，编排接线与旧行为等价性验证并入 M4 之前的接线收尾。当前Codex 面板选歌结果可以直接接队播放。
- 旧 `public/app.js` 页面仍可从回退入口访问，作为回滚通道保留至 M5。
- 「开发 StrictMode 双重装配不重复生成任务」已在装配层用模块级单例保证；生产构建验证通过，dev-server 模式的双重 effect 回归留待 M5 收口清单。
