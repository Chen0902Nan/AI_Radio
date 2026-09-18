# M4 验证报告：SSE 状态通知

日期：2026-09-17。基线：M3 完成后的工作区。

## 1. 实现内容

| 项 | 位置 | 合同对应 |
| --- | --- | --- |
| EventsService | `apps/api/src/events/events.service.ts` | RxJS Subject 广播；消息 `{ v:1, seq(单调), type, sessionId?, epoch?, segueId?, transitionId?, state?, code?, message?, degraded? }`；有界 recent 缓存仅作诊断，**不承诺 Last-Event-ID 重放** |
| EventsController | `apps/api/src/events/events.controller.ts` | `@Sse('events')`，`cache-control: no-store`、`x-accel-buffering: no`；连接终止（完成/错误/退订）经 RxJS `finalize` 释放订阅与连接计数 |
| 事件源 | dj-pipeline `finalize` → `dj-status`；orchestrator `prepareBatch` 完成 → `refill-status`；settings POST → `config-changed` | 只通知状态，不发播放命令、不携带队列、不成为队列事实来源 |
| 模块注册 | AppModule | TEST_HOOKS 模式同样注册（事件不是测试专用能力） |

补歌批次的交付方式保持不变：仍以 `POST /api/queue/refill` 响应为唯一交付途径；SSE 的 `refill-status` 只提示「有一批已生成/失败」，不含曲目数据，不会造成同一批歌曲双份入队。

## 2. 已执行验证（本次现场，独立端口/数据库）

| 检查 | 结果 |
| --- | --- |
| `GET /api/events` 返回 `200 text/event-stream` | ✅ |
| 订阅后触发 `POST /api/settings`，客户端收到 `{type:'config-changed', sessionId, key, seq:1, v:1}` | ✅ |
| 两条并发连接各收到同一 seq 事件（广播语义） | ✅ |
| 客户端断开后 `_diag` 显示 connections 从 1 → 0（监听/订阅释放） | ✅ |
| 全套回归：`npm test` 122 + playback 9 = 131 全绿；三包 typecheck 0 错误；`npm run build` 成功 | ✅ |

## 3. 边界与说明

- 断线恢复采用「重连拉快照」：客户端重连后用 `GET /api/session`、`GET /api/feedback`、`GET /api/settings`、`GET /api/dj/jobs/:id` 重建状态；SSE 只加速后续通知。服务端不做历史事件重放。
- 客户端（React）订阅侧的去重处理入口（按 `segueId+transitionId`、`seq` 幂等）随 M5 的编排接线一并收口：M4 交付的是服务端事件合同与连接生命周期。
- 长连接经过 Vite dev 代理时需保持不缓冲（`x-accel-buffering: no` 已设置）；本验证直连 Nest。
