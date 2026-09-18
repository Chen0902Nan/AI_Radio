# 迁移验证 — 2026-09-18

| 检查 | 结果 |
| --- | --- |
| 原 31 个受 Git 管理的 JS 源文件 | 全部迁移到对应 `.mts` / `.cts`，旧文件均不存在 |
| Node 原生擦除类型 + JS 语法解析 | 31/31 通过；未执行需要真实服务的探针 |
| `npm run typecheck` | contracts、web、api、tools 全部通过 |
| `npm test` | 163/163 通过；含构建、Nest HTTP/SQLite、播放控制器、进程重启与清理 |
| `npm run test:browser` | 3/3 通过；真实 Chrome + 本地 API/音频替身 |
| `npm test -w @radio/contracts` | 30/30 通过 |
| `npm test -w @radio/web` | 33/33 通过 |
| 锁文件 | 仅根开发依赖增加已在项目使用的 `@types/node@24.13.5` |

浏览器覆盖首批等待、手动歌单后恢复混合选歌、停止后不误播、登录错误恢复、SSE/DJ/歌曲切换。未运行真实 Codex、Fish、网易云或两小时持续播放验收。

`node --check file.cts` 在当前 Node 版本下不擦除类型，因此语法验证采用 Node 自带 `stripTypeScriptTypes` 后交给 `node --check --input-type`；实际 `.cts` 执行由 Node test runner 的通过结果证明。

保留已有无关工作区改动；全局 diff 检查报告的 `.gitignore` 末尾空行在本任务开始前已存在。此次没有提交或推送。
