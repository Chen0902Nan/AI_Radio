# M2 验证报告：新 Nest 服务 + 旧网页

日期：2026-09-17。基线：M1 完成后的工作区。

## 1. 迁移内容

按 Persistence/Config → Music/Codex → Preparation/DJ → Listening/Controllers 顺序迁入 `apps/api`：

| 旧文件 | 新位置 | 说明 |
| --- | --- | --- |
| `server/db.js` | `src/persistence/db.service.ts` | 原 schema/原语义；Nest 生命周期初始化 |
| `server/netease.js` | `src/music/netease.service.ts` | 身份缓存镜像、登录、资料、音源分类全部保留 |
| `server/codex.js` | `src/codex/codex.service.ts` | 子进程执行/失败分类/校验/注入导出为独立函数（DJ 复用） |
| `server/orchestrator.js` | `src/preparation/orchestrator.service.ts` | session+epoch 协调、冷却、降级逐行对应 |
| `server/fish.js` | `src/dj/fish.service.ts` | 免费模型请求头、成品有效性、取消全部保留 |
| `server/mp3-duration.js` | `src/dj/mp3-duration.ts` | 纯函数 |
| `server/dj-audio-cache.js` | `src/dj/audio-cache.ts` | 缓存键分隔符逐字节一致（`\0`）；废纸篓淘汰 |
| `server/dj-script.js` | `src/dj/dj-script.service.ts` | schema、提示词、搜索摘要一致 |
| `server/dj-pipeline.js` | `src/dj/dj-pipeline.service.ts` | 任务状态机/同键复用/冷却逐行对应 |
| `server/index.js` 路由 | 4 个 Controller + StaticController | 合同依据 `docs/migration/route-contract.md` |

关键实现决策：

- 全局 `LegacyExceptionFilter` 保证未捕获异常渲染为旧合同 `{ code:'server_error', message }`，不被 Nest 默认格式替换。
- 音频与 DJ 音频路由直接操作 `res`（`writeHead`/`pipe`），不在 Nest 管道内 JSON 包装；Range/206/416 与断开停止上游读取逐行保留。
- 测试钩子路由只在 `RADIO_TEST_HOOKS=1` 时注册（模块装配期判定），正常启动无 `_test` 路由（已用日志验证两种模式）。
- 数据路径由 `projectRoot()` 向上查找带 `workspaces` 的 package.json 定位，修复了 tsc 保留 `dist/config` 目录层级导致 `__dirname` 上推三级不足的问题；编译后 `PUBLIC_DIR`/`DB_FILE` 实测指向项目根。

## 2. 已执行验证（本次现场）

### 2.1 合同探测（独立端口 8795/8796/8798 + 独立 SQLite，未触碰真实数据）

| 检查 | 结果 |
| --- | --- |
| `/api/health` 返回 `{ ok, loggedIn, account, testHooks }` | ✅ |
| `/api/session/start` 首次 `reused=false`、重复 `reused=true` 且同 id | ✅ |
| `/api/settings` POST→GET 往返一致（refillThreshold=3） | ✅ |
| 反馈添加（summary like+1）→撤销（revoked=true） | ✅ |
| `/api/plays/start` 无会话自动建会话、返回 playId；`/api/plays/end` ok | ✅ |
| `/api/session/stop` 返回 `{ ok, ended, id, reason, adjustments }` 且作废任务 | ✅ |
| `/api/session/adjustment` 无会话 409 `NO_SESSION` | ✅ |
| `/api/dj/prepare` 缺身份 400 `invalid_request` | ✅ |
| `/api/dj/jobs/未知` 404 `not_found`；cancel 幂等 `cancelled:false` | ✅ |
| `/api/dj/preview` 会话进行中 409 `session_active` | ✅ |
| 静态：`/` 200 html、`/login` 200、`/program-contract.js` 200 js | ✅ |
| `_test` 路由仅 TEST_HOOKS=1 注册 | ✅ |

### 2.2 旧网页连接新 Nest（无头 Chrome，真实登录态，音频静音）

| 检查 | 结果 |
| --- | --- |
| 页面加载、账号显示（Pluto_Magic）、红心 456 首 + 6 歌单读取 | ✅ |
| 点击开播 → 真实歌曲解析 → 同源 `/api/audio/:id` 出声（`started=true`、currentTime 增长、playId=1） | ✅ |
| 暂停 → paused=true；恢复 → 进度继续增长 | ✅ |
| 停止 → 会话结束、状态文案正确 | ✅ |
| 喜欢反馈写入（feedback map 更新） | ✅ |
| 刷新重连既有会话（不新建） | ✅ |

### 2.3 离线测试

全套 `npm test` 122/122 通过（111 旧 + 11 契约 parity）；`npm run typecheck` 三包零错误。

## 3. 未完成与边界

- 补歌/DJ 注入链路的浏览器级回归（`verify-orchestration` / `verify-dj-smoke`）尚未指向新服务重跑：脚本按旧入口 `server/index.js` 拉起隔离服务。M2 后续将脚本适配为可指定新服务入口，再补一轮注入回归。
- 真实 Codex 补歌跨批验证与真实 Fish 串播验证留待条件允许时补证（M5 收口）。
- 旧服务入口未删除；迁移期间旧新路由不同时掌握同一任务状态（验收时只启动其一）。
