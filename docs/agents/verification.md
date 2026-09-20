# 验证选择与隔离

选择测试、修改验证工具或运行 `verify:*` 前读取。当前命令以根目录及工作区的 `package.json` 为准。

## 根据行为影响选择检查

| 改动影响 | 验证范围 |
| --- | --- |
| 仅文档、文案 | 核对差异、引用路径和命令；无行为变化时不跑全套测试 |
| 局部工具或业务逻辑 | 对应类型检查与定向测试；工具使用 `npm run typecheck:tools` |
| 跨模块逻辑、共享契约或持久化 | `npm run typecheck` 与 `npm test`；持久化变更补验旧数据兼容性、幂等或事务边界中实际受影响的部分 |
| 播放状态、队列、会话或 DJ 异步衔接 | 对应控制器／接口测试与受影响的浏览器用例；多条流程交叉时运行 `npm run test:browser` |
| 网易云、Codex 或 Fish 接入 | 先跑替身测试，再按本次验收目标运行已授权的真实链路；条件不具备时记录未验证项 |

定向运行测试前先构建它依赖的产物：部分用例读取 `apps/api/dist`、`apps/web/dist-playback` 或 `@radio/contracts`，浏览器用例读取 `apps/web/dist`。根 `npm test` 和 `npm run test:browser` 已包含构建。

`scripts/browser/` 使用真实 Chrome 和本地接口、音频替身，可以验证页面及播放交互，不能证明真实供应商链路通过。资料读取探针也不能证明完整收听流程通过。

## 运行真实验证前核对副作用

1. 确认脚本连接或启动哪个服务，是否写入设置、反馈、会话，是否调用真实供应商；不能只根据脚本名称或 `--skip-real` 判断。
2. 确认脚本与服务的数据库路径指向同一个临时库；分别核对登录态、音频缓存和报告输出路径。仅指定 `RADIO_DB_FILE` 不会隔离其他文件。
3. 对会修改登录态或文件的验证，使用独立 checkout 和独立数据目录；复用凭证时沿用已有授权，避免把真实用户数据作为故障注入对象。尚不能隔离的脚本先修正隔离能力，再执行会写数据的场景。

## 本地隔离探针（2026-09-20 整改后）

先执行 `npm run build`。以下保留入口默认自建 Nest/SQLite 服务和真实 Chrome，供应商、音乐与 DJ 音频均为本地替身：

```sh
npm run verify:playback
npm run verify:session
npm run verify:codex
npm run verify:fixes
npm run verify:dj-smoke
npm run verify:orchestration -- --skip-real
node scripts/verify-stability.mts --duration-min=0.02 --sample-ms=300
```

稳定性脚本默认观察 120 分钟；上面的短时命令只验收入口、采样与清理，不代表两小时稳定性已通过。`--skip-real` 只控制编排工具的专门真实选歌步骤；决定整个环境是否使用替身的是默认模式或显式 `--real`。

所有探针由 `scripts/lib/verification-environment.mts` 持有环境生命周期：

- 启动前覆盖 `RADIO_DATA_DIR`、`RADIO_DB_FILE`、`RADIO_SESSION_FILE`、`DJ_AUDIO_CACHE_DIR`，同时隔离上游临时镜像、Chrome profile 和中间报告。即使父进程指定了真实路径，也不会用于本地故障注入。
- 默认仅安装本地供应商替身，未声明的供应商方法直接失败。注入模式只存在于工具子进程；最外层 `finally` 关闭浏览器与服务，并将临时目录移入废纸篓。
- `--base=...` 因不能完整恢复外部服务状态，在任何修改前拒绝。不能借用已启动的真实实例做故障注入。
- 共享报告默认写到 `.scratch/verification/`，`RADIO_REPORT_OUT` 可覆盖目录；稳定性详细样本用 `RADIO_STABILITY_OUT` 覆盖文件。文档中的结论仍须取本次报告，不能沿用旧报告。
- 浏览器通过可见按钮、只读 `data-radio-observation` 和原生媒体状态验收，不提供任意改写播放状态的生产全局对象。

真实模式需已获授权，并显式提供 `--real --session-file=<登录态文件>`；会复制登录态到临时目录，不移动原件。本轮未执行真实模式。`verify:dj-smoke`、`verify:fixes` 只支持替身场景并拒绝真实模式。其他入口的真实步骤和注入步骤仍应分别报告，不能把含故障注入的整份报告描述为纯真实供应商验收。

当前路径实现见 `apps/api/src/config/app-config.ts`：默认仍使用根目录 `data/`；`RADIO_DATA_DIR` 修改整个目录默认值，数据库、登录态和 DJ 缓存的单项变量优先。运行服务本身不会因为使用独立端口而自动隔离数据。

## 质量报告

`npm run check:quality` 扫描手写源码、测试、工具及手写声明，排除依赖与构建产物。普通函数基准为 50 有效行、复杂度 10、嵌套 3，React 组件规模基准为 200 有效行，文件为 500 有效行。报告是审查线索，不是硬门禁；超限须查阅或更新 [逐项处理记录](../plans/2026-09-20-code-quality-dispositions.md)。类型错误仍由 `npm run typecheck` 阻止。

## 完成证据

记录实际执行的命令、通过或失败结果及验证范围；区分本次新失败与原有失败。真实服务报告说明使用的服务和数据范围，但不记录 Cookie、令牌或密钥。需要随仓库共享的证据和未验证项放在 `docs/`，本机草稿留在 `.scratch/`。

## 技术债修复后的增量检查

`npm run check:quality:delta` 读取 `docs/quality-baseline.json`，拒绝新函数/文件超限，以及已登记函数超过保留上限；已纳入 `npm test` 的第一步。报告命令 `npm run check:quality` 仍不阻断。

基线以文件路径、符号名、同名出现序号定位，不依赖行号；移动或新增同名匿名函数可能需要人工复核。指标未超标准时使用标准上限，已超标准时使用登记上限。修复后的例外应删除或下调，不保留已经消除的宽限。检查命令不写基线；新增例外必须同时写具体理由与复评条件，不能靠刷新 JSON 绕过审查。基线记录的是代码规模，不能替代职责、契约和竞态测试。
