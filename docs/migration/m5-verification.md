# M5 验证报告与迁移完成状态

> 最新状态（2026-09-17 迁移收口后）：下方各节是当时的分阶段记录，不能直接当作最终源码的验收结论。审查发现的播放/补歌接线、SSE 客户端、DJ 终态通知与展示、测试产物及故障注入问题已按 TDD 修复，见 [修复报告](../../.scratch/stack-migration-audit/fix-results.md)。**修复后的真实 Codex/Fish 已在补记缺口 3 现场确认**。下方「两小时稳定性结果」是修复**之前**的运行，其记录没有补歌批次与队列指标，不能据其证明「补歌持续供给」；**修复后的连续两小时复验仍未执行**，待验收项集中列在文末「剩余待验收」。

日期：2026-09-17。基线：M4 完成后的工作区。

## 1. 编排接线收尾（M3 遗留项）

`apps/web/src/app/radio-context.tsx` 完成与旧行为等价的编排接线：

- `refill.onBatch`：只追加、不替换；去重范围 = 当前曲 + 待播 + 已失败（与发给服务端的排除集合完全一致）；降级批次显示提示文案。
- `refill.getContext/getExclusion`：pendingCount 只数歌曲条目；排除集合按平台歌曲 id。
- `segue.requestPrepare`：提交 + 2s 轮询 + 170s 截止（略大于服务端 150s 总截止）；终态映射 ready/unavailable/stale；任何失败不抛出。
- 播放失败登记 `failedIds`（供补歌排除）；首次出声记播放记录。

## 2. 最终验收（本次现场，构建产物 + 单一入口）

全部在 `apps/api/dist` 编译产物上执行（`node apps/api/dist/main.js`，Nest 服务 React 构建产物 + API）：

| 验收项（实施文档 §7） | 方法 | 结果 |
| --- | --- | --- |
| 工程：安装/typecheck/build | `npm ci` 等价（npm install）+ `npm run typecheck`（0 错误）+ `npm run build`（三包全过） | ✅ |
| 契约：样例 + 无效输入 | parity 测试 11/11 + 离线全套 122/122 | ✅ |
| 媒体身份 | playback-controller 9/9（同曲重播区分、旧媒体事件过滤、加载中暂停） | ✅ |
| 补歌：并发/旧 epoch/停止 | 并发同 epoch 第二请求 `deduped=true`；旧 epoch `superseded`；停止后 `session_ended`；降级批次 `source:library, degraded:true` 带真实可播曲目 | ✅ |
| 播放生命周期 | React 页面：开播出声（currentTime 0.51→增长）→ 下一首（3.66s 增长）→ 停止（paused=true）；无页面错误 | ✅ |
| 数据往返 | settings/feedback/会话复用（M2 §2.1 全部探测） | ✅ |
| SSE | M4 报告（订阅/广播/断开释放） | ✅ |
| 旧入口可回滚 | `node server/index.js` health 正常 | ✅ |

**未验收项（明确列出，不用模拟冒充）**：

- 自然跨批（真实曲从头自然播完接补歌批次）与真实串播（Codex+Fish+真实歌曲→DJ→歌曲）：需要真实 Codex/Fish 条件与整曲时长，列为待验收，条件允许时按 scripts/verify-* 补证。
- 两小时现有功能稳定性：待验收项。
- 天气/日历/聊天：不在迁移范围（实施文档 §9 的后续产品顺序）。

## 3. 清理与收尾

- `.gitignore` 补充四类构建产物（`apps/api/dist`、`apps/web/dist`、`apps/web/dist-playback`、`packages/contracts/dist`）。
- 根 `package.json` 描述更新为产品语义，不再写「第一阶段音乐链路验证」。
- 旧 `server/` + `public/` 入口保留为回滚通道（实施文档 §6：回退代码保留至验收通过）。旧入口与新入口**不得同时对真实库执行启动收尾**——验收时只启动其一。真实串播/两小时验收通过后，按废纸篓规则移入 `~/.Trash`。
- 无本次产生的无用临时文件：验证用临时 SQLite 均在 `/tmp` 并已清理；测试清理走废纸篓。

## 4. 启动说明（迁移后）

```sh
# 依赖与版本：Node v24.16.0（.nvmrc）；npm workspaces 单 lockfile
nvm use
npm install

# 生产：构建三包，Nest 单一入口（服务 React 产物 + API + 音频 + SSE）
npm run build
npm start                            # 加载根 .env 和 env proxy；测试模式用 npm run start:test

# 开发：一条命令启动 Vite + Nest，打开 http://127.0.0.1:5173
npm run dev
# 自动完成首次构建；前端 HMR，后端/共享包变更后编译并重启后端。
# Ctrl+C 一起停止；原来的独立服务需先在旧终端停止，避免端口冲突。

# 环境变量：复制 .env.example（如有）或按 docs/migration/data-config-paths.md §2 配置
# 数据库/缓存/登录态仍在项目根 data/，路径解析不依赖编译产物位置
```

## 5. 文件映射索引

| 旧 | 新 |
| --- | --- |
| `server/db.js` | `apps/api/src/persistence/db.service.ts` |
| `server/netease.js` | `apps/api/src/music/netease.service.ts` |
| `server/codex.js` | `apps/api/src/codex/codex.service.ts` |
| `server/orchestrator.js` | `apps/api/src/preparation/orchestrator.service.ts` |
| `server/fish.js` / `mp3-duration.js` / `dj-audio-cache.js` | `apps/api/src/dj/{fish.service,mp3-duration,audio-cache}.ts` |
| `server/dj-script.js` / `dj-pipeline.js` | `apps/api/src/dj/{dj-script.service,dj-pipeline.service}.ts` |
| `server/index.js` | `apps/api/src/main.ts` + 4 个 Controller + `http/static.controller.ts` |
| `public/program-contract.js` | `packages/contracts/src/index.ts`（parity 11/11） |
| `public/app.js`（媒体执行） | `apps/web/src/playback/playback-controller.ts` |
| `public/app.js`（UI/编排） | `apps/web/src/app/radio-context.tsx` + `src/features/*` |
| `public/index.html` / `style.css` | `apps/web/index.html` + `src/styles/main.css`（Tailwind @theme） |
| `public/login.html` / `login.js` | `apps/web/src/features/login/LoginPage.tsx`（补记缺口 1 完成） |

剩余待迁项：无。`public/login.html`+`login.js` 的 React 化、`public/orchestrator.js`+`segue-controller.js` 的 TS 化均已在补记缺口 1 完成（该节写于完成之前）。

---

# M5 补记（2026-09-17 第二轮）：三个缺口的收口

> 本节是审核反馈后的补记：迁移主体完成后，针对「登录页/控制器未迁移、测试覆盖指向旧实现、真实验收与清理未完成」三类缺口继续执行。

## 缺口 1：登录页与两个控制器迁移

| 项 | 位置 | 验证 |
| --- | --- | --- |
| RefillController TS 化 | `apps/web/src/orchestration/refill-controller.ts` | parity（新旧对照）9 组场景：阈值触发/在途去重/成功计数/退避→等待恢复→resume/取消作废/空批次 no_new_tracks/session_ended 重评 |
| SegueController TS 化 | `apps/web/src/orchestration/segue-controller.ts` | parity：interval-1 提前准备→自然结束就绪播报、跳过/失败不累计、机会关闭迟到结果丢弃、DJ ended 继续、重复 ended 拒绝 |
| 登录页 React 化 | `apps/web/src/features/login/LoginPage.tsx` | 浏览器实测：二维码渲染、状态文案、刷新按钮、803 跳转接线齐全，无页面错误 |
| radio-context 切换 | 移除对 `public/*.js` 的运行时 require，浏览器端不再加载旧控制器 | web 构建成功 |

## 缺口 2：测试覆盖目标核查（审核指出的关键问题）

审核正确：此前 131 项通过里绝大多数 import 旧 `server/`+`public/`，不能证明新实现。已全部重定向：

| 测试文件 | 旧目标 | 新目标 |
| --- | --- | --- |
| program-contract.test.mjs | `public/program-contract.js` | `@radio/contracts`（TS） |
| segue-controller.test.mjs | `public/segue-controller.js` | `apps/web/dist-playback/orchestration/segue-controller.cjs`（TS） |
| dj-script.test.mjs | `server/dj-script.js` | `apps/api/dist/dj/dj-script.service.js`（TS） |
| fish-audio.test.mjs | `server/fish.js` 等 | `apps/api/dist/dj/*.js`（TS） |
| dj-pipeline.test.mjs | `server/dj-pipeline.js` | `apps/api/dist/dj/dj-pipeline.service.js`（TS，工厂注入形状保持） |
| player-media.test.mjs | 旧 `public/` DOM 页面 | **有意保留**：锁定回滚通道行为，旧入口删除时一并处理 |

重定向过程中按测试合同重构了 `dj-pipeline.service.ts`（Nest 类委托给与旧版同形的 `createDjPipeline` 工厂，`fish.evaluateAudioDuration`/`validateVoiceConfig`/`synthesize` 与 `dj.generateSegueScript` 保持模块级导出）。重定向后全套 `npm test` 131/131。

过程中发现并修复的接线缺陷（重定向测试的价值证明）：
- `DjPipelineService` Nest 构造器未注入 fish/djScript → 启动即崩（此前 E2E 在重构前执行，属验收时序漏洞）。
- `_test` 钩子路由限定了方法而旧合同为任意方法 → verify-orchestration 的 codex-stats reset 失效导致 4 项误 FAIL。

## 缺口 3：真实验收

**Codex/Fish 现场确认（纠正「缺条件」的预设）**：Codex CLI 6.6s 应答正常；Fish 真实合成 HTTP 200（71KB MP3，真实库保存音色）。

| 验收 | 结果 |
| --- | --- |
| 编排验证（新 Nest，含注入链路 + 浏览器） | 29 PASS / 0 FAIL（与旧服务对照 28 PASS/0 FAIL 同水平，多出真实 Codex 一项） |
| 真实 Codex 补歌 | PASS：10.4s、2.28 万 tokens、3 首带理由可播批次 |
| verify-dj-smoke（新 Nest + 浏览器） | 39/39（歌→DJ→歌注入链、同源音频、反馈禁用、跳过语义） |
| 真实 DJ 全链路（API 级） | prepare→ready 54.1s：真实 Codex 搜索写稿（1 来源）→ 真实 Fish 合成 17.3s → 同源 Range 206 |
| 浏览器整链：真实歌→真实 DJ→歌 | 2 首真实歌自然 ended → 第 3 首触发真实 prepare → DJ 真实成品同源接管 → 目标歌曲实际出声 26.68s。加速边界明示：前两首 seek 加速触发真实 ended；DJ 与目标歌自然播放 |
| React 自然结束→自动下一首 | 浏览器实测：ended 后 track 65536→65538、保持播放 |

## 缺口 4 补记：验证脚本全部指向新实现

清理前审计发现 3 个脚本仍 require 旧文件，已切换并验证：

| 脚本 | 旧引用 | 新引用 | 验证 |
| --- | --- | --- | --- |
| scripts/read-library.mjs | `server/netease.js` | `apps/api/dist/music/netease.service.js` | 真实账号资料读取「全部通过」 |
| scripts/verify-codex.mjs | `server/codex.js` | `apps/api/dist/codex/codex.service.js` | 语法检查通过 |
| scripts/verify-orchestration.mjs | `public/orchestrator.js` + 默认旧服务入口 | TS 版 RefillController + 默认 `apps/api/dist/main.js` | 加载检查通过 |

新代码对旧文件的全部残留仅为注释（「迁移自 server/xxx」溯源说明）。

## 两小时稳定性结果（已完成）

120/120 分钟采样（12:44–14:45）：**停滞 0、页面/采样错误 0、health 异常 0、异常暂停 0**；28 个不同媒体连续推进（补歌链路持续供给，队列从未耗尽）；播放速度经采样间隔核对为 1x（无异常 seek）。报告：`/tmp/stability-report.json`。

边界如实记录：观测期间 DJ 音频采样为 0——观测时段 React 端 `segue.maybePrepare` 的自动准备接线尚未完成。**观测后已补齐接线**（见下节），DJ 机会路径在 React 端经浏览器整链验证（interval-1 自动准备→就绪→自然结束自动播出→目标歌出声）。两小时验收结论限定为「纯音乐链路稳定」；DJ 机会路径的连续 2 小时复验可另行安排。

## 验收矩阵证据索引（收口后）

| 验收项 | 证据 |
| --- | --- |
| 工程 | typecheck 0 错误；`npm run build` 成功；lockfile dry-run 一致 |
| 契约 | contracts parity 11/11；controllers parity 9/9；131 项全套（目标均为新实现） |
| 媒体身份 | playback-controller 9/9（Node 确定性） |
| 补歌 | 并发 deduped/superseded/session_ended 实测；verify-orchestration 29/29（含真实 Codex 10.4s/2.28 万 tokens） |
| 自然跨批 | verify-orchestration 浏览器节 PASS；React ended→自动下一首实测 |
| DJ 边界 | verify-dj-smoke 39/39 |
| 真实串播 | API 级 ready 54.1s（真实写稿+合成）+ 浏览器整链（目标歌 26.68s 出声，加速边界明示） |
| 试听 | 合同探测 + fish-audio 测试（24/24，新实现） |
| 数据 | settings/feedback/会话往返实测（M2 §2.1） |
| SSE | 订阅/广播/断开释放实测（M4） |
| 持续运行 | 两小时观测：0 停滞/0 错误/28 媒体推进（纯音乐链路；DJ 自动准备接线为遗留项，见上） |

---

# M5 最终清理记录（2026-09-17，CHEN 确认后执行）

| 动作 | 明细 |
| --- | --- |
| 移入废纸篓 | `server/`（10 文件）、`public/`（8 文件）→ `~/.Trash/{server,public}.<ts>.trash` |
| 退役测试 | `parity.test.mjs`、`orchestrator-parity.test.mjs`（对照对象已删）、`player-media.test.mjs`（旧 DOM 页面行为锁定，随页面退役）→ 废纸篓 |
| 静态服务 | `static.controller.ts` 移除 public 回退分支；无扩展名路径统一 SPA fallback 到 `apps/web/dist/index.html`（修复 /login 404） |
| 入口切换 | `package.json`：`main`/`start`/`start:test` 指向 `apps/api/dist/main.js`；移除过渡脚本 `start:api` |
| 死代码清理 | `app-config.ts` 的 `PUBLIC_DIR` 导出（随 public/ 退役，无消费者） |

清理后验收：全套 109/109（131 − 22 项退役）；typecheck/build 0 错误；`/`与`/login`浏览器渲染正常（二维码加载、456 首资料读取）；旧 `/app.js` 404 符合预期；会话/健康 API 正常。

**迁移至此收口**：生产实现只剩 `apps/web` + `apps/api` + `packages/contracts` 一套；无两套生产实现并存。

---

# 剩余待验收

> 2026-09-20 目标更新：本节的未验收事实继续保留；后续产品范围与顺序以 [Claudio 路线图](../plans/2026-09-20-claudio-roadmap.md) 为准，历史“每日 08:45 准备”已由图示 07:00 规划、09:00 早间及其他节律替代。这里不表示新增能力已实施。

以下是迁移收口后仍未执行的验收项。**不要把它们读成已通过**——本地离线测试、隔离浏览器和只读接口核验都不能替代它们。

| 待验收项 | 现状 | 为什么没做 |
| --- | --- | --- |
| 修复后的连续两小时复验（含补歌批次与队列指标） | 未执行 | 已有的两小时记录（12:44–14:45）是修复**前**的运行，缺少补歌批次/队列指标；修复后未重跑 |
| DJ 机会路径的连续两小时复验 | 未执行 | 观测时段 React 端自动准备接线尚未完成；接线补齐后只做过浏览器整链验证，未做长时复验 |
| 探索选歌的真实两小时收听 | 未执行 | 见 [探索选歌验收记录](../../.scratch/discovery-selection/verification.md)：本地测试、隔离浏览器与真实只读资料核验已通过，真实长时收听未做 |
| 天气、飞书当日日程、开场播报、文字聊天、每日 08:45 准备 | 未实现 | 不属于迁移范围，是迁移后的产品顺序（见 [迁移方案 §9](../plans/2026-09-17-stack-migration.md)） |

重跑连续观测：`npm run build` 后以 `RADIO_TEST_HOOKS=1 PORT=8792 RADIO_DB_FILE=/tmp/stability.db node --env-file-if-exists=.env --use-env-proxy apps/api/dist/main.js` 起独立实例，再跑 `node scripts/verify-stability.mts --base=http://127.0.0.1:8792 --duration-min=120`。注意历史报告写在 `/tmp/stability-report.json`，重启即失，需要长期留存时另存副本。

---

> 本文引用的 `.scratch/` 证据文件属本机工作区，未随仓库分发；克隆中这些链接不可用。
