# 路由合同清单（M0 冻结基线）

基线 commit：`1bf324a`；提取自 `server/index.js`（手写 http server，无路由框架）。
本文档是 M2「旧网页连接新 Nest 服务」的兼容性依据：迁移必须保留客户端实际依赖的方法、状态码、字段与错误体；没有列出的内部字段不属于合同。

方法限制说明：旧服务用 `if (p === X && req.method === 'POST')` 判断的路由**对其他方法会落到静态文件兜底**（返回 404 或 HTML）；没有写方法的路由**接受任意方法**。新服务对无方法路由保持宽松、对带方法路由的缺失方法返回 404（与旧行为一致——旧行为是落兜底而非 405）。

所有 JSON 响应带 `cache-control: no-store`；错误体统一 `{ code, message }` 或 `{ ok: false, code, message }`，未捕获异常返回 500 `{ code: 'server_error', message }`。

## 1. 健康与登录

| 路由 | 方法 | 成功 | 失败/边界 | 字段合同 |
| --- | --- | --- | --- | --- |
| `/api/health` | 任意 | 200 `{ ok:true, loggedIn, account, testHooks }` | `ncm.whoami()` 抛错 → 500 | `account`: `{ userId, nickname, vipType, savedAt }` 或 `null`；`testHooks` 由 `RADIO_TEST_HOOKS=1` |
| `/api/login/qr` | 任意 | 200 `{ key, ...qrimg数据 }` | 上游失败 → 500 | 透传 `login_qr_create` body.data |
| `/api/login/poll?key=` | 任意 | 200 `{ code, message, account? }` | 缺 key → 400 `{ code:400, message:'缺少 key' }`；`code=803` 时附 `account` | code: 800 过期 / 802 已扫 / 803 成功 |
| `/api/logout` | 任意 | 200 `{ ok:true }` | — | 清 session 文件与 URL 缓存 |

## 2. 音乐资料与音源

| 路由 | 方法 | 成功 | 失败/边界 | 字段合同 |
| --- | --- | --- | --- | --- |
| `/api/library` | 任意 | 200 `{ account, liked:{ count, tracks }, playlists }` | 未登录 → 401 `{ code:'NOT_LOGGED_IN', message:'未登录' }` | tracks 条目：`{ id, name, artists, album, durationMs, fee, mvId }`；playlists: `{ collected, created, pages, total }` |
| `/api/playlist/:id` | 任意 | 200 `{ via, trackCount, returned, tracks }` | 未登录 → 401（无 message）；上游失败 → 500 | `via`: `playlist_detail.trackIds` 或 `playlist_track_all` |
| `/api/resolve/:id` | 任意 | 200 `{ id, code, message, kind, identityKind, level, br, fee, playable, cached, audioUrl }` | 注入失败 → 502；未登录 → 401；`audioUrl` 仅 full 时非空 `'/api/audio/:id'` | `code`: `ok`/`trial_only`/`unplayable`；`identityKind`: `anon`/`user`；支持 `?force=1` |
| `/api/audio/:id` | 任意 | 200/206 音频流（转发上游 content-type/length/range/etag/accept-ranges，`cache-control: no-store`） | 解析失败：401（NOT_LOGGED_IN）/ 502；非完整音源 → 409 `{ code:'trial_only'|'unplayable', fee }`；CDN 非 ok → 502 `{ code:'upstream_status', status }`；Range 非法 → 上游处理 | **必须保留 Range 透传（206）**、客户端断开停止上游读取；**不得 JSON 包装、不得压缩/缓冲** |

## 3. 选歌与补歌

| 路由 | 方法 | 成功 | 失败/边界 | 字段合同 |
| --- | --- | --- | --- | --- |
| `/api/plan` | POST | 200 `{ ok:true, picks, dropped, rejected, meta }` | 未登录 → 401 `{ ok:false, code:'NOT_LOGGED_IN' }`；Codex 失败 → 502 `{ ok:false, code, message, rejected, meta.candidateIds }`；全部不可播 → 502 `code:'no_playable'`（附 `picks` 全量检查结果） | picks 条目含 `playable:true` 与 `reason`；`meta.durationMs/candidates` |
| `/api/queue/refill` | POST | 200 `{ ok:true, picks, dropped, rejected, source, degraded, meta }`（可能附 `deduped:true`） | 未登录 → 401；曲库读取失败 → 503 `code:'library_unavailable'`；候选耗尽 → 409 `code:'candidates_exhausted'`；会话结束 → 409 `code:'session_ended'`；过期意图 → 409? `code:'superseded'`（服务端 orchestrator 返回，无显式 status 映射时为 502）；其他 → 502 | `source`: `codex`/`library`/`forced`；`degraded:true` 表示降级续播；请求体 `{ sessionId, epoch, excludeIds, count, brief, timeoutMs?, skipCodex? }` |

注意：旧服务把 orchestrator 的 `superseded` 结果以 502 返回（落进默认分支），客户端只看 `code`。新服务保持同一状态码映射。

## 4. 会话、反馈、设置、播放记录

| 路由 | 方法 | 成功 | 失败/边界 | 字段合同 |
| --- | --- | --- | --- | --- |
| `/api/session` | GET（无方法限制） | 200 `{ ok:true, session, feedback }` | — | session: `{ id, started_at, ended_at, end_reason, adjustments }` 或 `null`；feedback: `{ like, dislike }` |
| `/api/session/start` | POST | 200 `{ ok:true, session }` | — | 已有会话时 `session.reused:true`（刷新不新建会话） |
| `/api/session/stop` | POST | 200 `{ ok:true, ended, id?, reason?, adjustments? }` | — | 结束会话并作废补歌/DJ 在途任务 |
| `/api/session/adjustment` | POST | 200 `{ ok:true, adjustments }` | 无会话 → 409 `code:'NO_SESSION'`；缺 key → 400 `{ ok:false, message:'缺少 key' }`（无 code 字段） | value 为 null/'' 时删除该键 |
| `/api/feedback` | GET | 200 `{ ok:true, active, summary }` | — | active 条目为数据库行（`track_id`、`sentiment` 等蛇形字段）；POST 响应为驼峰 `feedback` 行 |
| `/api/feedback` | POST | 200 `{ ok:true, feedback, summary }` | 缺 trackId → 400 `{ ok:false, message:'缺少 trackId' }`；非法 sentiment → 400 `{ ok:false, message }` | `source` 默认 `'ui'`；同曲旧反馈自动撤销 |
| `/api/feedback/:trackId` | DELETE | 200 `{ ok:true, revoked, trackId?, previous?, summary }` | 不存在时 `revoked:false` | — |
| `/api/settings` | GET | 200 `{ ok:true, settings, djVoice }` | — | settings 全量键值（字符串值）；djVoice: `{ ready, code, message, voiceReferenceId }`，**永不含密钥** |
| `/api/settings` | POST | 200 `{ ok:true, setting, settings, djVoice }` | 缺 key → 400 `{ ok:false, message:'缺少 key' }` | 保存后触发 `djPipeline.voiceConfigChanged()` 解除配置阻塞 |
| `/api/plays/start` | POST | 200 `{ ok:true, playId, session }` | 缺 trackId → 400 `{ ok:false, message:'缺少 trackId' }` | 无会话时自动 `startSession()` |
| `/api/plays/end` | POST | 200 `{ ok:true }` | — | `outcome` 默认 `'unknown'` |

## 5. DJ 串场

| 路由 | 方法 | 成功 | 失败/边界 | 字段合同 |
| --- | --- | --- | --- | --- |
| `/api/dj/prepare` | POST | 200 `{ ok:true, job, reused? }` | 校验失败 → 400 `code:'invalid_request'`；payload 冲突 → 409 `code:'payload_conflict'`；会话不存在/已结束/不匹配 → 409 `session_ended`；顺序过期 → 409 `stale_epoch`；冷却/阻塞 → 429（`cooldown_active` 或 `*_blocked`）；其他失败 → 502 | job 形状见 program-contract `validateSegueJob`（`{ segueId, state, stage, createdAt, updatedAt, transition, script?, audio? }`） |
| `/api/dj/jobs/:id` | GET | 200 `{ ok:true, job }` | 未知 → 404 `code:'not_found'`；过期 → 404 `code:'expired'` | 轮询间隔 2s、截止 170s（客户端） |
| `/api/dj/jobs/:id/cancel` | POST | 200 `{ ok:true, cancelled }` | 幂等：未知任务也返回 `cancelled:false` | — |
| `/api/dj/audio/:assetId` | 任意 | 200/206 `audio/mpeg`（`accept-ranges: bytes`, `cache-control: no-store`） | 未知/路径穿越 → 404 `{ code:'asset_not_found' }`；Range 非法 → 416 `{ 'content-range': 'bytes */<total>' }` | 本地文件流；拒绝缓存目录之外资产 |
| `/api/dj/preview` | POST | 200 `{ ok:true, audio:{ assetId, url, durationMs, bytes } }` | 会话进行中 → 409 `code:'session_active'`；未配置 → 409 `code:'not_configured'`；密钥错 → 401 `code:'auth'`；限流 → 429；其他 → 502 | 试听与正式节目身份独立 |

## 6. 测试钩子（仅 `RADIO_TEST_HOOKS=1` 时注册）

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/_test/fail-next` | 任意 | 接下来 N 次 resolve 返回 502 |
| `/api/_test/fail-audio-next` | 任意 | 接下来 N 次 /api/audio 返回 502 |
| `/api/_test/unplayable-next` | 任意 | 接下来 N 次 resolve 上游返回无 url（缓存失效路径） |
| `/api/_test/resolve-error-next` | 任意 | 接下来 N 次 resolve 抛错（服务不可用降级） |
| `/api/_test/sample-candidates?n=` | 任意 | 只跑抽样函数（反馈加权/降权验证） |
| `/api/_test/codex-mode` | 任意 | codex 注入模式 `{ mode, delayMs }` |
| `/api/_test/fish-mode` | 任意 | fish 注入模式 |
| `/api/_test/dj-script-mode` | 任意 | dj-script 注入模式 |
| `/api/_test/codex-stats`（`?reset=1`） | 任意 | codex 调用计数 |
| `/api/_test/orchestrator-state` | 任意 | 在途补歌任务列表 |
| `/api/_test/clear-url-cache` | 任意 | 清音源 URL 缓存 |
| `/api/_test/refill-forced` | 任意 | 强制接下来 N 次补歌返回指定错误 |
| `/api/_test/refill-forced-picks` | 任意 | 强制接下来 N 次补歌返回指定曲目 |

新服务的测试开关保持显式 `RADIO_TEST_HOOKS=1`；正常启动不得注册任何 `_test` 路由。

## 7. 静态文件与非 API 路径

- `/favicon.ico` → 204；其余非 `/api` 路径按 public 目录静态服务（无扩展名路径映射同名 `.html`，如 `/login`）；未命中 → 404 text/plain。
- 404 也发生在 API 路径 GET 到带方法限制的路由上（落兜底）。
- 所有静态响应 `cache-control: no-store`。

> **M5 之后的实际行为**（旧 `public/` 已退役，本节记录的是迁移期行为）：静态根改为 `apps/web/dist`；`/api` 与 `/api/*`、以及非 GET/HEAD 的请求直接返回 **404 JSON `{ code:'NOT_FOUND', message:'接口不存在' }`**，不再落 SPA fallback；无扩展名路径（`/`、`/login`）统一回落 `apps/web/dist/index.html`。见 [m5-verification 最终清理记录](./m5-verification.md)。

## 8. M5 收口后新增与变更的路由

**本节不属于 M0 冻结基线**，是迁移收口与探索选歌（ADR-0005）之后的路由现状补充。核对代码：`apps/api/src/events/events.controller.ts`、`listening.controller.ts`、`preparation/discovery-selection.ts`。

| 路由 | 方法 | 成功 | 失败/边界 | 字段合同 |
| --- | --- | --- | --- | --- |
| `/api/events` | GET（SSE） | `200 text/event-stream`，`cache-control: no-store`、`x-accel-buffering: no` | — | 消息 `{ v:1, seq(单调), type, sessionId?, epoch?, segueId?, transitionId?, state?, code?, message?, degraded? }`；**不承诺 Last-Event-ID 重放**，重连后自行拉 `session`/`feedback`/`settings`/`dj/jobs/:id` 快照 |
| `/api/events/_diag` | GET | `200 { ok, connections, seq }` | — | 连接与序号诊断，供测试钩子使用 |
| `/api/plays/history` | GET | `200 { ok:true, automatic, recent }` | — | `automatic` 是最近 50 条自动歌曲 `{ track_id, selection_source }`（跨会话/重启保留，用于 50/50 比例）；`recent` 是最近播放记录 |

`/api/plays/start` 的请求体新增两个可选字段（ADR-0005）：`selectionId`（服务端登记的选歌归属，用于按实例幂等记账）与 `playInstanceId`（首次实际出声的实例标识，截断至 200 字符去重）。`sessionId` 对应的会话已结束或不存在 → `409 { ok:false, code:'session_ended' }`。**手动点播不携带 `selectionId`**，因此不计入 50/50 比例；DJ 不走歌曲记录。

`/api/queue/refill`、`/api/plan` 的 `picks` 条目现在额外携带 `selectionId` 与 `selectionSource`（`library` / `discovery`），归属在准备时由服务端固定并写入 `selections` 表，后续歌单变化不回写历史。没有 `selections` 记录时来源按未知处理，不补造比例。

### DJ 请求顺序补充（2026-09-20）

`POST /api/dj/prepare` 的 `epoch` 和新增 `transitionSeq` 均为必填非负安全整数；缺失序号、字符串或非法数字返回 400 `invalid_request`。`transitionId` 不用于排序。同一 `(epoch, transitionSeq)` 的重复请求复用任务；改变身份、目标或文案上下文返回 409 `payload_conflict`。同一版本内更旧机会以及更旧版本均在供应商调用前返回 409 `stale_epoch`。

`GET /api/session` 与 `POST /api/session/start` 的 `session` 对象增加 `highest_epoch` 和 `transition_seq`（旧库分别初始化为 0/-1）。页面刷新后复用开放会话但不自动播放；再次开播先恢复更高的共同版本再发起补歌或 DJ 准备。服务端完成/回收任务不清除持久顺序，停止会话后不允许复用其任务。

### 反馈读取空值兼容（2026-09-20）

`GET /api/feedback` 的 `active[].track_name` 可为字符串、null 或缺省；没有歌曲名的旧记录仍是合法反馈。共享 HTTP 解析器保留 null，展示层使用“未命名歌曲”。对象、数组等错误类型仍拒绝，不把非法值强制转字符串。
