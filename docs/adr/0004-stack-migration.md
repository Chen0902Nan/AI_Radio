# 技术栈迁移：React + TypeScript + Vite / NestJS / SQLite，队列归属不变

日期：2026-09-17。状态：已接受并执行完毕。M0→M5 已收口，旧 `server/` + `public/` 已按废纸篓规则退役，生产实现只剩 `apps/web` + `apps/api` + `packages/contracts` 一套；审查发现的行为回归已修复，修复后的真实 Codex/Fish 已现场确认（见补记缺口 3）。**唯一尚未执行的迁移验收是「修复后的连续两小时复验」**；迁移范围外的待办（探索选歌真实长时收听、DJ 机会路径复验、天气/日历/聊天/每日准备）集中在 M5 报告文末「剩余待验收」。证据见 [M5 验证报告](../migration/m5-verification.md) 和 [修复报告](../../.scratch/stack-migration-audit/fix-results.md)。

## 背景

音乐链路（网易云接入、播放与失败恢复、Codex 选歌、自动补歌、会话/反馈、DJ 串场）已在纯 JS 单体上实现并通过离线与真实链路验证（111 项离线测试 + 浏览器回归）。后续产品功能（天气/日历开场、聊天点歌、每日准备）需要更清晰的模块边界与类型保障。用户已确定目标栈：React + TypeScript + Vite、Tailwind CSS、NestJS + TypeScript、SQLite（保留 `node:sqlite`）。

## 决定

1. 仓库改为 npm workspaces：`apps/web`（React+TS+Vite+Tailwind）、`apps/api`（NestJS+TS，默认 Express adapter）、`packages/contracts`（共享纯类型与校验器，browser ESM + Node CJS 双格式产物）。
2. **队列与播放决定继续由浏览器持有**（ADR-0003 不变）。NestJS 与 SSE 的引入不构成把队列搬到服务端的理由；SSE 只做任务状态通知，不发播放命令、不当队列事实来源。
3. 数据库保持 SQLite + `node:sqlite`，不改 schema、不引入 ORM；数据访问集中在 Persistence 模块。
4. 迁移按 M0→M5 分期保行为推进；每期以既有测试与合同文档（route-contract / data-config-paths）为兼容依据，旧应用在迁移期间保持可启动、可回滚。

## Considered Options

- **服务端持有队列（Nest 网关推送播放指令）**：与 ADR-0003 冲突，且会重做一遍已验证的播放器竞态处理；不采用。
- **只做前端框架化、后端保持手写 http**：改动更小，但模块边界、依赖注入与后续定时准备（每日 08:45）缺少承载；用户已确定 NestJS。
- **立即引入 Fastify adapter / ORM / 多包管理器**：叠加未验证变量；本次一律不加。

## Consequences

- 共享契约必须双格式构建（Node CJS + browser ESM），`package exports` 明确入口；服务端初期保持 CommonJS 编译以兼容现有依赖，不全局改 `type: module`。
- `program-contract` 等 JS 模块以 TS 重写时，先用同输入/同输出的 parity 测试证明行为一致，再删除旧实现（M1）。
- 音频流与 SSE 排除统一 JSON 包装、压缩与缓冲；Range/206 语义逐字保留。
- 编译产物路径从 `__dirname` 相对改为集中配置的绝对数据目录，指向既有 `data/`，避免 dist 后丢登录态或新建空库。
- 废弃代码在 M5 验收通过后移入废纸篓；回滚入口保留至验收通过，回退不得覆盖迁移期间新写的真实用户反馈。

---

> 本文引用的 `.scratch/` 证据文件属本机工作区，未随仓库分发；克隆中这些链接不可用。
