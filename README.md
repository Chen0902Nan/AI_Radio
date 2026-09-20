# AI Radio

## 开发启动

使用 Node.js 24.16.0；首次拉取项目后先执行 `npm ci`。在项目根目录运行：

```sh
npm run dev
```

打开 http://127.0.0.1:5173 。命令会先构建共享 contracts 与后端，然后同时启动 Vite 和 Nest，不需要提前手动 build。

- 前端 React/CSS 修改由 Vite 热更新。
- 后端或共享 contracts 修改后自动重新编译，成功后重启后端。编译失败时保留上一次服务，修正代码后自动重试。
- 后端重启会中断当前收听会话；需要重新开播。
- `Ctrl+C` 一起停止前后端。若端口已被旧服务占用，先在旧终端停止它，再执行命令。

根 `.env` 自动加载。后端默认 `127.0.0.1:8787`；设置 `HOST` / `PORT` 时，统一开发入口会同步调整 Vite 的 API 代理。修改 `.env` 后重新运行命令。DJ 语音需配置 `FISH_API_KEY`，音乐账号在 `/login` 扫码登录。

仅启动后端并监听修改：`npm run dev -w @radio/api`。

## 构建后运行

```sh
npm run build
npm start
```

此模式打开 http://127.0.0.1:8787 ，由 Nest 提供构建后的页面，不包含热更新。

## 测试与类型检查

```sh
npm test            # 先构建 contracts/web/api 与播放控制器产物，再跑离线全套（不需要外部服务）
npm run typecheck   # contracts / web / api / tools 四份严格检查
```

需要 Chrome、真实登录态或真实服务的回归另有入口：`npm run test:browser` 与 `npm run verify:*`（`verify:playback`、`verify:session`、`verify:orchestration`、`verify:dj-smoke` 等），它们会另起独立实例，请勿指向正在使用的服务。

## 项目结构

```
apps/web/           React + Vite + Tailwind 前端；播放控制器与队列在这里
apps/api/           NestJS 后端：音乐接入、选歌与补歌、DJ 串场、会话与播放记录、SSE
packages/contracts/ 共享纯类型与校验器
scripts/            开发启动器与核验脚本（TypeScript：.mts / .cts）
data/               SQLite、网易云登录态、DJ 音频缓存（不入 Git）
```

## 文档

- [Claudio 最终架构与开发路线图](docs/plans/2026-09-20-claudio-roadmap.md) — 按用户指定施工图逐项规划未来功能、迁移、阶段依赖及验收；这是目标，不代表当前均已实现。
- [最终目标架构决策](docs/adr/0007-claudio-target-architecture.md) — Claude Code、WebSocket、07:00/09:00 节律、PWA、音响与现有架构的关系。
- [CONTEXT.md](CONTEXT.md) — 领域词汇表，术语以此为准。
- [docs/adr/](docs/adr/) — 架构决定（队列归属、技术栈迁移、音乐接入、探索选歌、工具链 TypeScript）。
- [docs/migration/route-contract.md](docs/migration/route-contract.md) — HTTP 路由合同。
- [docs/migration/data-config-paths.md](docs/migration/data-config-paths.md) — 数据路径与环境变量清单。
- [docs/migration/m5-verification.md](docs/migration/m5-verification.md) — 迁移收口状态与**尚未验收的事项**。
- [AGENTS.md](AGENTS.md) — 给 AI 协作代理的项目约定与硬边界。
