# AGENTS.md

## 项目约定

个人电台：以歌曲为主体、DJ 偶尔串场。**领域术语以 `CONTEXT.md` 为准**，写代码、命名、写测试都用其中的词，不要自造同义词。

- 结构：`apps/web`（React + Vite + Tailwind）、`apps/api`（NestJS）、`packages/contracts`（共享契约）、`scripts`（开发与核验工具）、`data`（SQLite／登录态／DJ 音频缓存，已 gitignore）。
- 工具脚本一律 TypeScript：ESM 用 `.mts`、CommonJS 用 `.cts`（`scripts/**`、`apps/web/test/**`），由 `tsconfig.tools.json` 与 `npm run typecheck:tools` 检查（ADR-0006）。
- 运行时锁 `.nvmrc`（Node v24.16.0），npm workspaces 单 lockfile，不换包管理器。启动与构建命令见 `README.md`。

### 硬边界

- **废纸篓规则**：删除缓存、测试临时目录或退役代码，一律移入 `~/.Trash`（退回 `<dir>/.trash`），不自动清空。只有进程自建的空临时目录（`/tmp/radio-codex-*`、`/tmp/radio-dj-*`）可以用 `rmSync`。
- **队列归属不变**：节目队列与播放决定由浏览器持有，服务端只准备内容；换框架或加推送通道都不构成把它搬到服务端的理由（ADR-0003）。
- **默认不提交、不推送**，除非明确要求。
- **测试钩子**只在 `RADIO_TEST_HOOKS=1` 时注册；正常启动不得暴露 `_test` 路由。核验脚本一律用独立端口加 `RADIO_DB_FILE` 指向临时库，不碰真实 `data/radio.db`。
- **真实链路不能冒充**：真实 Codex／Fish／网易云的验收不能用离线测试或替身结果顶替；没有条件就如实记为待验收。

### 深入文档

| 主题 | 位置 |
| --- | --- |
| 领域词汇 | `CONTEXT.md` |
| 架构决定 | `docs/adr/`（0003 队列归属、0004 技术栈迁移、0005 探索选歌、0006 工具链 TypeScript） |
| HTTP 路由合同 | `docs/migration/route-contract.md` |
| 数据路径与环境变量 | `docs/migration/data-config-paths.md` §2 |
| 迁移收口状态与未验收项 | `docs/migration/m5-verification.md` |

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo. **`.scratch/` is gitignored and untracked — it only exists on this machine.** Anything that must be shared belongs in `docs/`, not in `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
