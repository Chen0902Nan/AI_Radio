# M0 基线验证报告

日期：2026-09-17；执行者：Claude Code（Max）。
基线 commit：`1bf324a`（工作区仅有 `docs/plans/` 与本次 M0 改动）。

## 1. 已执行的验证

| 项 | 结果 | 性质 |
| --- | --- | --- |
| `node --test scripts/tests/program-contract.test.mjs scripts/tests/segue-controller.test.mjs scripts/tests/dj-script.test.mjs scripts/tests/playback-checks.test.mjs` | 68/68 通过 | 本次现场，离线（无外部服务） |
| `npm test`（全套 7 个测试文件） | 111/111 通过 | 本次现场，离线 |
| 全部 server/public JS 文件语法检查 | 通过 | 实施文档 §2.2 已记录，本次未重跑 |
| 真实浏览器回归（verify-playback / fixes / orchestration / session / dj-smoke） | **未执行** | 需要真实登录态、Chrome 与外部服务；列为历史结果，不标作本次通过 |
| 真实 Codex / Fish / 网易云音源调用 | **未执行** | 同上 |

历史基线：最新接入记录（`.scratch/dj-segue/verification/access.md`）报告全套 111/111，与本次现场结果一致。

## 2. 本次改动

1. `scripts/lib/trash.mjs`：新增临时目录清理助手（移入 `~/.Trash`，退回 `<dir>/.trash`，不自动清空）。
2. 三处违反废纸篓规则的 `rmSync` 清理改为移入废纸篓：
   - `scripts/tests/dj-pipeline.test.mjs`（`makeDeps().cleanup`）
   - `scripts/tests/fish-audio.test.mjs`（`tmpCache().cleanup`）
   - `scripts/verify-fixes.mjs`（`tmpOut` 清理）
3. 修正后全套 111/111 通过；`~/.Trash` 中可观察到测试产物（`dj-pipe-*` 等），验证清理路径真实生效。`player-media.test.mjs` 与 `verify-orchestration.mjs` 原本就用 rename 进 `.Trash` 的方式，未改动。
   - 例外说明：`server/codex.js` 与 `server/dj-script.js` 的 Codex 子进程临时目录（`/tmp/radio-codex-*`、`/tmp/radio-dj-*`）仍用 `rmSync`。这些是进程自建的空工作目录（schema 副本与空 work 目录），不含用户数据，不适用废纸篓规则，保持原样。
4. `.nvmrc` 固定 Node v24.16.0；`package.json` 增加 `engines.node >=24.16.0 <25`。理由：本机实测版本，支持 `node:sqlite`（实验性 API 于 24 稳定化进程）、`--env-file-if-exists`、`--use-env-proxy` 启动选项，是唯一有真实运行证据的版本。
5. 新增本文档与 [route-contract.md](./route-contract.md)、[data-config-paths.md](./data-config-paths.md)、[ADR-0004](../adr/0004-stack-migration.md)。

## 3. 跳过项与阻塞说明

- 未重启用户现有服务实例；未读取 `.env`、cookie、真实数据库内容。
- 未执行两小时稳定性验收与真实链路（跨批/串播）验收——这两项属于 M2/M5 的退出条件，在获得真实服务条件前不伪造通过。
- 历史/本次、真实/替身的区分在各验证报告顶部已有记录指针（本次补加 DJ report 与任务 07 的状态指针）。

## 4. 对后续分期的输入

- 路由合同：`docs/migration/route-contract.md`（含旧路由方法限制的真实行为）。
- 数据/配置路径：`docs/migration/data-config-paths.md`。
- 行为合同：实施文档 §5；队列归属按 ADR-0003 不变（新 ADR-0004 不推翻它）。

---

> 本文引用的 `.scratch/` 证据文件属本机工作区，未随仓库分发；克隆中这些链接不可用。
