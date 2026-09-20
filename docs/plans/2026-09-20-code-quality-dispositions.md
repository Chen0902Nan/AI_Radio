# 代码质量逐项处理记录

2026-09-20；对应 [整改计划](./2026-09-20-code-standards-remediation.md)。本记录列出全部原始超限项以及最终保留例外，不把文件迁移计作复杂度降低。

## 统计口径与结果

`npm run check:quality` 使用 TypeScript AST。有效行按终端语法 token 的非空行统计，排除空白、纯注释；模板字符串、正则和 JSX 由 parser 识别。函数范围包含签名和内嵌函数的文本行；分支与嵌套遇内嵌函数即停止，内嵌函数另计。复杂度为 1 加 if/循环/catch/条件表达式/非 default case/逻辑运算符；嵌套计 if/循环/条件表达式/switch/try/catch，else-if 和 try/catch 并列，JSX 不增加深度。组件为含 JSX 的大写命名函数，行数基准 200，其余为 50；复杂度 10、嵌套 3、文件 500。

基线为 `61eb293bdc566cbfe8be27edcb22ca95ac19f403` 的干净归档；当前为未提交工作区。两个报告使用同一工具、同一排除规则，含手写 `.d.ts`，不含 `node_modules/dist/dist-playback/.git/.scratch/.trash`。最初文本初筛的嵌套 4 项与 AST 的 9 项不同：后者固定计入条件表达式和 try/catch，且不再靠缩进估计；本表以 AST 为准。

| 指标 | 基线 | 完成后 |
| --- | ---: | ---: |
| 手写文件 | 72 | 152 |
| 文件超过 500 行 | 6 | 0 |
| 函数任一指标超限 | 80 | 57 |
| 普通函数超过 50 行 | 35 | 21 |
| 圈复杂度超过 10 | 62 | 44 |
| 控制流嵌套超过 3 | 9 | 4 |

数字降低不是完成判据：新增校验使部分字段校验器复杂度上升；新拆出的任务存储与播放器装配仍作为例外明确保留。当前没有组件超过 200 行。

## 原始六个大文件

| 原文件 | 基线有效行 | 当前有效行 | 主要职责去向 |
| --- | ---: | ---: | --- |
| [apps/api/src/dj/dj-pipeline.service.ts](../../apps/api/src/dj/dj-pipeline.service.ts) | 511 | 74 | pipeline、request-order、pipeline-jobs、pipeline-steps |
| [apps/web/src/app/radio-context.tsx](../../apps/web/src/app/radio-context.tsx) | 602 | 28 | radio-runtime、app-store、play-records、dj-job-watcher、radio-events、dj-settings |
| [apps/web/src/playback/playback-controller.ts](../../apps/web/src/playback/playback-controller.ts) | 570 | 474 | playback-types、playback-snapshot、track-source、playback-retry |
| [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts) | 901 | 11 | models、identity、各类 validation、samples、http；根入口只重导出 |
| [scripts/verify-dj-smoke.mts](../../scripts/verify-dj-smoke.mts) | 561 | 37 | dj-smoke-browser、dj-smoke-scenarios、统一验证环境 |
| [scripts/verify-orchestration.mts](../../scripts/verify-orchestration.mts) | 805 | 33 | orchestration-controller/server/browser-*，环境由 withVerification 管理 |

## 原始 80 个超限函数的处理

指标统一为 **有效行 / 圈复杂度 / 最大嵌套**。当前仍超限者的理由与复评条件见下一节。标注“已整改”仅表示对应函数或拆分后的职责已回到基准内。

| 基线文件、符号 | 原指标 | 处理及当前去向 |
| --- | --- | --- |
| [apps/api/src/codex/codex.service.ts:146](../../apps/api/src/codex/codex.service.ts#L146) `validatePicks` | 36/13/2 | 已整改；[apps/api/src/codex/codex-selection.ts:13](../../apps/api/src/codex/codex-selection.ts#L13) `validatePicks`，36/7/2；候选字段读取与列表识别独立 |
| [apps/api/src/codex/codex.service.ts:211](../../apps/api/src/codex/codex.service.ts#L211) `pickTracks` | 116/26/3 | 已整改；[apps/api/src/codex/codex.service.ts:26](../../apps/api/src/codex/codex.service.ts#L26) `pickTracks`，12/7/1；拆出供应商、进程、注入和结果筛选 |
| [apps/api/src/dj/audio-cache.ts:56](../../apps/api/src/dj/audio-cache.ts#L56) `createAudioCache` | 186/5/1 | 保留例外；[apps/api/src/dj/audio-cache.ts:79](../../apps/api/src/dj/audio-cache.ts#L79) `createAudioCache`，185/5/1 |
| [apps/api/src/dj/audio-cache.ts:169](../../apps/api/src/dj/audio-cache.ts#L169) `put` | 55/18/3 | 保留例外；[apps/api/src/dj/audio-cache.ts:191](../../apps/api/src/dj/audio-cache.ts#L191) `put`，55/17/3 |
| [apps/api/src/dj/dj-pipeline.service.ts:168](../../apps/api/src/dj/dj-pipeline.service.ts#L168) `createDjPipeline` | 367/11/1 | 保留例外；[apps/api/src/dj/pipeline.ts:53](../../apps/api/src/dj/pipeline.ts#L53) `createDjPipeline`，125/11/1；状态存储与三个准备阶段独立；装配外层保留例外 |
| [apps/api/src/dj/dj-pipeline.service.ts:250](../../apps/api/src/dj/dj-pipeline.service.ts#L250) `finalize` | 37/16/2 | 已整改；[apps/api/src/dj/pipeline-jobs.ts:70](../../apps/api/src/dj/pipeline-jobs.ts#L70) `finalize`，20/10/1；终态转换与结果统计分开 |
| [apps/api/src/dj/dj-pipeline.service.ts:292](../../apps/api/src/dj/dj-pipeline.service.ts#L292) `run` | 96/29/4 | 已整改；[apps/api/src/dj/pipeline-steps.ts:25](../../apps/api/src/dj/pipeline-steps.ts#L25) `createPreparationRunner`，17/1/0；拆为研究、合成、发布，各阶段入口和完成检查有效性 |
| [apps/api/src/dj/dj-pipeline.service.ts:417](../../apps/api/src/dj/dj-pipeline.service.ts#L417) `prepare` | 47/12/3 | 已整改；[apps/api/src/dj/pipeline.ts:109](../../apps/api/src/dj/pipeline.ts#L109) `prepare`，29/9/2；提取请求顺序门、配置和任务复用 |
| [apps/api/src/dj/dj-script.service.ts:143](../../apps/api/src/dj/dj-script.service.ts#L143) `summarizeSearchActivity` | 29/12/3 | 保留例外；[apps/api/src/dj/dj-script.service.ts:143](../../apps/api/src/dj/dj-script.service.ts#L143) `summarizeSearchActivity`，29/12/3 |
| [apps/api/src/dj/dj-script.service.ts:275](../../apps/api/src/dj/dj-script.service.ts#L275) `generateSegueScriptImpl` | 40/28/2 | 保留例外；[apps/api/src/dj/dj-script.service.ts:275](../../apps/api/src/dj/dj-script.service.ts#L275) `generateSegueScriptImpl`，40/28/2 |
| [apps/api/src/dj/dj-script.service.ts:322](../../apps/api/src/dj/dj-script.service.ts#L322) `finish` | 53/11/1 | 保留例外；[apps/api/src/dj/dj-script.service.ts:322](../../apps/api/src/dj/dj-script.service.ts#L322) `finish`，53/11/1 |
| [apps/api/src/dj/dj.controller.ts:19](../../apps/api/src/dj/dj.controller.ts#L19) `prepare` | 18/6/4 | 已整改；[apps/api/src/dj/dj.controller.ts:19](../../apps/api/src/dj/dj.controller.ts#L19) `prepare`，11/2/1 |
| [apps/api/src/dj/dj.controller.ts:84](../../apps/api/src/dj/dj.controller.ts#L84) `preview` | 17/7/4 | 保留例外；[apps/api/src/dj/dj.controller.ts:77](../../apps/api/src/dj/dj.controller.ts#L77) `preview`，17/7/4 |
| [apps/api/src/dj/fish.service.ts:122](../../apps/api/src/dj/fish.service.ts#L122) `synthesizeImpl` | 109/50/3 | 已整改；[apps/api/src/dj/fish.service.ts](../../apps/api/src/dj/fish.service.ts) 中由多个独立步骤替代，全部在阈值内；输入、供应商请求、正文解析与注入独立 |
| [apps/api/src/dj/mp3-duration.ts:47](../../apps/api/src/dj/mp3-duration.ts#L47) `mp3Duration` | 31/22/5 | 保留例外；[apps/api/src/dj/mp3-duration.ts:63](../../apps/api/src/dj/mp3-duration.ts#L63) `mp3Duration`，17/11/2 |
| [apps/api/src/http/static.controller.ts:28](../../apps/api/src/http/static.controller.ts#L28) `serve` | 30/11/1 | 保留例外；[apps/api/src/http/static.controller.ts:28](../../apps/api/src/http/static.controller.ts#L28) `serve`，30/11/1 |
| [apps/api/src/music/music.controller.ts:101](../../apps/api/src/music/music.controller.ts#L101) `audio` | 71/21/3 | 保留例外；[apps/api/src/music/music.controller.ts:105](../../apps/api/src/music/music.controller.ts#L105) `audio`，32/13/2 |
| [apps/api/src/music/netease.service.ts:72](../../apps/api/src/music/netease.service.ts#L72) `selectionLibrary` | 35/15/4 | 保留例外；[apps/api/src/music/netease.service.ts:80](../../apps/api/src/music/netease.service.ts#L80) `selectionLibrary`，34/14/4 |
| [apps/api/src/music/netease.service.ts:108](../../apps/api/src/music/netease.service.ts#L108) `discoveryCandidates` | 18/7/4 | 保留例外；[apps/api/src/music/netease.service.ts:115](../../apps/api/src/music/netease.service.ts#L115) `discoveryCandidates`，12/7/4 |
| [apps/api/src/music/netease.service.ts:281](../../apps/api/src/music/netease.service.ts#L281) `getUserPlaylists` | 49/13/3 | 保留例外；[apps/api/src/music/netease.service.ts:277](../../apps/api/src/music/netease.service.ts#L277) `getUserPlaylists`，47/12/3 |
| [apps/api/src/music/netease.service.ts:338](../../apps/api/src/music/netease.service.ts#L338) `getPlaylistTracks` | 45/21/3 | 保留例外；[apps/api/src/music/netease.service.ts:332](../../apps/api/src/music/netease.service.ts#L332) `getPlaylistTracks`，38/11/3 |
| [apps/api/src/music/netease.service.ts:453](../../apps/api/src/music/netease.service.ts#L453) `resolveTrack` | 61/23/2 | 已整改；[apps/api/src/music/netease.service.ts:437](../../apps/api/src/music/netease.service.ts#L437) `resolveTrack`，25/8/2 |
| [apps/api/src/persistence/db.service.ts:39](../../apps/api/src/persistence/db.service.ts#L39) `onModuleInit` | 54/5/2 | 保留例外；[apps/api/src/persistence/db.service.ts:41](../../apps/api/src/persistence/db.service.ts#L41) `onModuleInit`，58/7/2 |
| [apps/api/src/preparation/discovery-selection.ts:42](../../apps/api/src/preparation/discovery-selection.ts#L42) `pick` | 39/17/4 | 保留例外；[apps/api/src/preparation/discovery-selection.ts:42](../../apps/api/src/preparation/discovery-selection.ts#L42) `pick`，39/17/4 |
| [apps/api/src/preparation/orchestrator.service.ts:111](../../apps/api/src/preparation/orchestrator.service.ts#L111) `runPrepare` | 57/24/2 | 保留例外；[apps/api/src/preparation/orchestrator.service.ts:111](../../apps/api/src/preparation/orchestrator.service.ts#L111) `runPrepare`，62/28/2 |
| [apps/api/src/preparation/orchestrator.service.ts:178](../../apps/api/src/preparation/orchestrator.service.ts#L178) `prepareBatch` | 50/11/2 | 保留例外；[apps/api/src/preparation/orchestrator.service.ts:183](../../apps/api/src/preparation/orchestrator.service.ts#L183) `prepareBatch`，53/12/2 |
| [apps/api/src/preparation/preparation.controller.ts:34](../../apps/api/src/preparation/preparation.controller.ts#L34) `refill` | 64/23/3 | 保留例外；[apps/api/src/preparation/preparation.controller.ts:34](../../apps/api/src/preparation/preparation.controller.ts#L34) `refill`，64/23/3 |
| [apps/web/src/app/radio-context.tsx:112](../../apps/web/src/app/radio-context.tsx#L112) `executeSegueDecision` | 24/14/2 | 已整改；[apps/web/src/orchestration/radio-runtime.ts:59](../../apps/web/src/orchestration/radio-runtime.ts#L59) `executeSegueDecision`，9/5/1；React 适配独立；装配、设置、会话、事件与记账各自持有生命周期 |
| [apps/web/src/app/radio-context.tsx:138](../../apps/web/src/app/radio-context.tsx#L138) `getRadioInstance` | 185/4/2 | 已整改；[apps/web/src/orchestration/radio-runtime.ts:278](../../apps/web/src/orchestration/radio-runtime.ts#L278) `getRadioInstance`，38/2/1；React 适配独立；装配、设置、会话、事件与记账各自持有生命周期 |
| [apps/web/src/app/radio-context.tsx:342](../../apps/web/src/app/radio-context.tsx#L342) `startListening` | 37/23/4 | 已整改；[apps/web/src/orchestration/radio-runtime.ts:341](../../apps/web/src/orchestration/radio-runtime.ts#L341) `startListening`，22/10/2；React 适配独立；装配、设置、会话、事件与记账各自持有生命周期 |
| [apps/web/src/app/radio-context.tsx:401](../../apps/web/src/app/radio-context.tsx#L401) `waitForSegue` | 57/2/1 | 已整改；[apps/web/src/orchestration/dj-job-watcher.ts:85](../../apps/web/src/orchestration/dj-job-watcher.ts#L85) `wait`，11/2/1；任务监听器持有订阅与清理 |
| [apps/web/src/app/radio-context.tsx:403](../../apps/web/src/app/radio-context.tsx#L403) `<anonymous>` | 54/2/1 | 已整改；[apps/web/src/orchestration/dj-job-watcher.ts:85](../../apps/web/src/orchestration/dj-job-watcher.ts#L85) `wait`，11/2/1；原等待 Promise 回调拆成监听器命令 |
| [apps/web/src/app/radio-context.tsx:430](../../apps/web/src/app/radio-context.tsx#L430) `refresh` | 20/13/3 | 已整改；[apps/web/src/orchestration/dj-job-watcher.ts:83](../../apps/web/src/orchestration/dj-job-watcher.ts#L83) `refresh`，1/2/1；刷新与任务接纳分开 |
| [apps/web/src/app/radio-context.tsx:464](../../apps/web/src/app/radio-context.tsx#L464) `syncServerSnapshot` | 25/15/2 | 已整改；[apps/web/src/orchestration/radio-runtime.ts:417](../../apps/web/src/orchestration/radio-runtime.ts#L417) `syncServerSnapshot`，14/7/2；React 适配独立；装配、设置、会话、事件与记账各自持有生命周期 |
| [apps/web/src/app/radio-context.tsx:509](../../apps/web/src/app/radio-context.tsx#L509) `source.addEventListener(event)` | 15/16/3 | 已整改；[apps/web/src/orchestration/radio-events.ts](../../apps/web/src/orchestration/radio-events.ts) 中由多个独立步骤替代，全部在阈值内；事件过滤与运行时动作分开 |
| [apps/web/src/app/radio-context.tsx:587](../../apps/web/src/app/radio-context.tsx#L587) `notePlayStart` | 23/12/2 | 已整改；[apps/web/src/orchestration/play-records.ts](../../apps/web/src/orchestration/play-records.ts) 中由多个独立步骤替代，全部在阈值内；实际播放记账生命周期独立 |
| [apps/web/src/features/player/Player.tsx:13](../../apps/web/src/features/player/Player.tsx#L13) `Player` | 73/11/3 | 保留例外；[apps/web/src/features/player/Player.tsx:13](../../apps/web/src/features/player/Player.tsx#L13) `Player`，73/11/3 |
| [apps/web/src/orchestration/refill-controller.ts:88](../../apps/web/src/orchestration/refill-controller.ts#L88) `<anonymous>` | 25/13/1 | 已整改；[apps/web/src/orchestration/refill-controller.ts:109](../../apps/web/src/orchestration/refill-controller.ts#L109) `<anonymous>`，1/1/0 |
| [apps/web/src/orchestration/refill-controller.ts:209](../../apps/web/src/orchestration/refill-controller.ts#L209) `check` | 14/11/1 | 保留例外；[apps/web/src/orchestration/refill-controller.ts:214](../../apps/web/src/orchestration/refill-controller.ts#L214) `check`，14/11/1 |
| [apps/web/src/orchestration/refill-controller.ts:268](../../apps/web/src/orchestration/refill-controller.ts#L268) `handleResult` | 43/17/3 | 保留例外；[apps/web/src/orchestration/refill-controller.ts:273](../../apps/web/src/orchestration/refill-controller.ts#L273) `handleResult`，43/17/3 |
| [apps/web/src/orchestration/segue-controller.ts:156](../../apps/web/src/orchestration/segue-controller.ts#L156) `setConfig` | 29/11/2 | 保留例外；[apps/web/src/orchestration/segue-controller.ts:159](../../apps/web/src/orchestration/segue-controller.ts#L159) `setConfig`，29/11/2 |
| [apps/web/src/orchestration/segue-controller.ts:193](../../apps/web/src/orchestration/segue-controller.ts#L193) `onTrackStarted` | 14/11/1 | 保留例外；[apps/web/src/orchestration/segue-controller.ts:196](../../apps/web/src/orchestration/segue-controller.ts#L196) `onTrackStarted`，14/11/1 |
| [apps/web/src/orchestration/segue-controller.ts:219](../../apps/web/src/orchestration/segue-controller.ts#L219) `onQueueChanged` | 15/13/1 | 保留例外；[apps/web/src/orchestration/segue-controller.ts:222](../../apps/web/src/orchestration/segue-controller.ts#L222) `onQueueChanged`，15/13/1 |
| [apps/web/src/orchestration/segue-controller.ts:242](../../apps/web/src/orchestration/segue-controller.ts#L242) `onTrackEnded` | 46/28/1 | 保留例外；[apps/web/src/orchestration/segue-controller.ts:245](../../apps/web/src/orchestration/segue-controller.ts#L245) `onTrackEnded`，46/28/1 |
| [apps/web/src/orchestration/segue-controller.ts:349](../../apps/web/src/orchestration/segue-controller.ts#L349) `maybePrepare` | 50/17/1 | 保留例外；[apps/web/src/orchestration/segue-controller.ts:352](../../apps/web/src/orchestration/segue-controller.ts#L352) `maybePrepare`，51/17/1 |
| [apps/web/src/orchestration/segue-controller.ts:403](../../apps/web/src/orchestration/segue-controller.ts#L403) `_onPrepareResult` | 33/15/2 | 保留例外；[apps/web/src/orchestration/segue-controller.ts:407](../../apps/web/src/orchestration/segue-controller.ts#L407) `_onPrepareResult`，33/15/2 |
| [apps/web/src/orchestration/segue-controller.ts:488](../../apps/web/src/orchestration/segue-controller.ts#L488) `snapshot` | 27/13/2 | 保留例外；[apps/web/src/orchestration/segue-controller.ts:493](../../apps/web/src/orchestration/segue-controller.ts#L493) `snapshot`，28/13/2 |
| [apps/web/src/playback/playback-controller.ts:146](../../apps/web/src/playback/playback-controller.ts#L146) `sampleSnapshot` | 43/20/1 | 已整改；[apps/web/src/playback/playback-controller.ts:82](../../apps/web/src/playback/playback-controller.ts#L82) `captureSnapshot`，15/4/0；快照捕获、缓存与变化通知独立 |
| [apps/web/src/playback/playback-controller.ts:358](../../apps/web/src/playback/playback-controller.ts#L358) `play` | 64/20/3 | 已整改；[apps/web/src/playback/playback-controller.ts:263](../../apps/web/src/playback/playback-controller.ts#L263) `play`，19/6/1 |
| [apps/web/src/playback/playback-controller.ts:456](../../apps/web/src/playback/playback-controller.ts#L456) `resume` | 47/20/3 | 已整改；[apps/web/src/playback/playback-controller.ts:356](../../apps/web/src/playback/playback-controller.ts#L356) `resume`，14/8/2 |
| [packages/contracts/src/index.ts:282](../../packages/contracts/src/index.ts#L282) `makeTrackItem` | 19/14/1 | 保留例外；[packages/contracts/src/identity.ts:8](../../packages/contracts/src/identity.ts#L8) `makeTrackItem`，19/15/1；按契约职责迁移，强化实际类型校验 |
| [packages/contracts/src/index.ts:349](../../packages/contracts/src/index.ts#L349) `validateTransition` | 16/15/1 | 保留例外；[packages/contracts/src/transition-validation.ts:4](../../packages/contracts/src/transition-validation.ts#L4) `validateTransition`，19/27/1；按契约职责迁移，强化实际类型校验 |
| [packages/contracts/src/index.ts:366](../../packages/contracts/src/index.ts#L366) `validateQueueItem` | 21/14/2 | 保留例外；[packages/contracts/src/queue-validation.ts:19](../../packages/contracts/src/queue-validation.ts#L19) `validateQueueItem`，37/25/2；按契约职责迁移，强化实际类型校验 |
| [packages/contracts/src/index.ts:388](../../packages/contracts/src/index.ts#L388) `validatePrepareRequest` | 39/26/2 | 保留例外；[packages/contracts/src/transition-validation.ts:24](../../packages/contracts/src/transition-validation.ts#L24) `validatePrepareRequest`，41/31/2；按契约职责迁移，强化实际类型校验 |
| [packages/contracts/src/index.ts:454](../../packages/contracts/src/index.ts#L454) `sources.forEach callback` | 23/12/2 | 保留例外；[packages/contracts/src/script-validation.ts:12](../../packages/contracts/src/script-validation.ts#L12) `sources.forEach callback`，24/14/2；按契约职责迁移，强化实际类型校验 |
| [packages/contracts/src/index.ts:485](../../packages/contracts/src/index.ts#L485) `validateScript` | 92/38/3 | 保留例外；[packages/contracts/src/script-validation.ts:44](../../packages/contracts/src/script-validation.ts#L44) `validateScript`，95/42/3；按契约职责迁移，强化实际类型校验 |
| [packages/contracts/src/index.ts:532](../../packages/contracts/src/index.ts#L532) `claims.forEach callback` | 32/16/2 | 保留例外；[packages/contracts/src/script-validation.ts:94](../../packages/contracts/src/script-validation.ts#L94) `claims.forEach callback`，32/16/2；按契约职责迁移，强化实际类型校验 |
| [packages/contracts/src/index.ts:595](../../packages/contracts/src/index.ts#L595) `validateSegueJob` | 61/38/3 | 保留例外；[packages/contracts/src/job-validation.ts:11](../../packages/contracts/src/job-validation.ts#L11) `validateSegueJob`，61/45/3；按契约职责迁移，强化实际类型校验 |
| [packages/contracts/src/index.ts:662](../../packages/contracts/src/index.ts#L662) `validateEvent` | 26/17/2 | 保留例外；[packages/contracts/src/playback-events.ts:4](../../packages/contracts/src/playback-events.ts#L4) `validateEvent`，26/17/2；按契约职责迁移，强化实际类型校验 |
| [packages/contracts/src/index.ts:895](../../packages/contracts/src/index.ts#L895) `buildInvalidSamples` | 73/3/1 | 保留例外；[packages/contracts/src/samples.ts:150](../../packages/contracts/src/samples.ts#L150) `buildInvalidSamples`，73/3/1；按契约职责迁移，强化实际类型校验 |
| [scripts/browser/discovery.test.mts:12](../../scripts/browser/discovery.test.mts#L12) `test(真实浏览器：首批等待、来源记录、停止不误播、手动歌单后自动接回混合电台)` | 51/2/1 | 保留例外；[scripts/browser/discovery.test.mts:12](../../scripts/browser/discovery.test.mts#L12) `test(真实浏览器：首批等待、来源记录、停止不误播、手动歌单后自动接回混合电台)`，51/2/1 |
| [scripts/browser/discovery.test.mts:15](../../scripts/browser/discovery.test.mts#L15) `http.createServer callback` | 23/22/2 | 保留例外；[scripts/browser/discovery.test.mts:15](../../scripts/browser/discovery.test.mts#L15) `http.createServer callback`，23/22/2 |
| [scripts/browser/migration.test.mts:17](../../scripts/browser/migration.test.mts#L17) `test(浏览器：连续歌曲→SSE就绪DJ→歌曲、补歌、暂停恢复与新会话)` | 69/3/2 | 保留例外；[scripts/browser/migration.test.mts:62](../../scripts/browser/migration.test.mts#L62) `test(浏览器：连续歌曲→SSE就绪DJ→歌曲、补歌、暂停恢复与新会话)`，72/3/2 |
| [scripts/browser/migration.test.mts:24](../../scripts/browser/migration.test.mts#L24) `http.createServer callback` | 30/28/3 | 保留例外；[scripts/browser/migration.test.mts:69](../../scripts/browser/migration.test.mts#L69) `http.createServer callback`，31/28/3 |
| [scripts/lib/dev-runner.mts:10](../../scripts/lib/dev-runner.mts#L10) `runDev` | 118/8/3 | 保留例外；[scripts/lib/dev-runner.mts:10](../../scripts/lib/dev-runner.mts#L10) `runDev`，118/8/3 |
| [scripts/lib/library-checks.mts:17](../../scripts/lib/library-checks.mts#L17) `collectFailures` | 34/22/3 | 保留例外；[scripts/lib/library-checks.mts:17](../../scripts/lib/library-checks.mts#L17) `collectFailures`，34/22/3 |
| [scripts/read-library.mts:37](../../scripts/read-library.mts#L37) `main` | 124/16/3 | 保留例外；[scripts/read-library.mts:37](../../scripts/read-library.mts#L37) `main`，125/18/3 |
| [scripts/tests/dev-command.test.mts:10](../../scripts/tests/dev-command.test.mts#L10) `test(dev：冷启动先构建，修改后重启，编译失败保留服务，退出清理子进程)` | 51/2/1 | 保留例外；[scripts/tests/dev-command.test.mts:10](../../scripts/tests/dev-command.test.mts#L10) `test(dev：冷启动先构建，修改后重启，编译失败保留服务，退出清理子进程)`，51/2/1 |
| [scripts/tests/dj-pipeline.test.mts:45](../../scripts/tests/dj-pipeline.test.mts#L45) `makeDeps` | 55/1/0 | 保留例外；[scripts/tests/support/dj-pipeline-fixture.mts:24](../../scripts/tests/support/dj-pipeline-fixture.mts#L24) `makeDeps`，56/1/0；提取共用 typed fixture；声明表保留例外 |
| [scripts/tests/segue-controller.test.mts:22](../../scripts/tests/segue-controller.test.mts#L22) `makeHarness` | 60/1/0 | 保留例外；[scripts/tests/segue-controller.test.mts:22](../../scripts/tests/segue-controller.test.mts#L22) `makeHarness`，60/1/0 |
| [scripts/verify-codex.mts:169](../../scripts/verify-codex.mts#L169) `runBrowserChecks` | 87/9/1 | 已整改；[scripts/lib/codex-scenes.mts](../../scripts/lib/codex-scenes.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |
| [scripts/verify-dj-smoke.mts:103](../../scripts/verify-dj-smoke.mts#L103) `main` | 459/17/2 | 已整改；[scripts/lib/dj-smoke-scenarios.mts](../../scripts/lib/dj-smoke-scenarios.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |
| [scripts/verify-fixes.mts:77](../../scripts/verify-fixes.mts#L77) `runBrowserChecks` | 205/10/1 | 已整改；[scripts/lib/fixes-browser.mts](../../scripts/lib/fixes-browser.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |
| [scripts/verify-orchestration.mts:163](../../scripts/verify-orchestration.mts#L163) `runControllerUnitChecks` | 136/16/0 | 已整改；[scripts/lib/orchestration-controller.mts](../../scripts/lib/orchestration-controller.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |
| [scripts/verify-orchestration.mts:320](../../scripts/verify-orchestration.mts#L320) `runServerChecks` | 116/40/0 | 已整改；[scripts/lib/orchestration-server.mts](../../scripts/lib/orchestration-server.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |
| [scripts/verify-orchestration.mts:460](../../scripts/verify-orchestration.mts#L460) `runRealCodexRefill` | 19/11/1 | 已整改；[scripts/lib/orchestration-server.mts](../../scripts/lib/orchestration-server.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |
| [scripts/verify-orchestration.mts:499](../../scripts/verify-orchestration.mts#L499) `runBrowserChecks` | 325/46/1 | 已整改；[scripts/lib/orchestration-browser.mts](../../scripts/lib/orchestration-browser.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |
| [scripts/verify-playback.mts:59](../../scripts/verify-playback.mts#L59) `main` | 260/32/3 | 已整改；[scripts/lib/playback-scenes.mts](../../scripts/lib/playback-scenes.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |
| [scripts/verify-session.mts:215](../../scripts/verify-session.mts#L215) `runBrowserChecks` | 99/8/0 | 已整改；[scripts/lib/session-scenes.mts](../../scripts/lib/session-scenes.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |
| [scripts/verify-stability.mts:38](../../scripts/verify-stability.mts#L38) `main` | 76/16/4 | 已整改；[scripts/lib/stability-scenes.mts](../../scripts/lib/stability-scenes.mts) 按场景拆分，各新函数均在阈值内；外层统一资源清理 |

## 最终全部 57 个保留例外

下列每项都有具体职责理由和再次审查的触发条件；不免除后续变更的行为测试。新增函数也包含在内，不能用此清单为未列出的复杂度增长自动豁免。

| 当前文件、符号 | 实际指标 | 保留理由 | 重新评估条件 |
| --- | --- | --- | --- |
| [apps/api/src/dj/audio-cache.ts:34](../../apps/api/src/dj/audio-cache.ts#L34) `parseMetadata` | 10/14/1 | 单一磁盘记录的身份、字节数、时长、时间和保留字段逐项早返回，所有值来自 unknown | 缓存格式新增字段或多个缓存复用该记录时 |
| [apps/api/src/dj/audio-cache.ts:79](../../apps/api/src/dj/audio-cache.ts#L79) `createAudioCache` | 185/5/1 | 缓存工厂闭包统一拥有资产索引、容量、引用计数和淘汰时钟；外层行数含内嵌方法 | 新增独立缓存后端或可分离生命周期 |
| [apps/api/src/dj/audio-cache.ts:191](../../apps/api/src/dj/audio-cache.ts#L191) `put` | 55/17/3 | 顺序执行命中复用、空间回收、临时写入、原子发布和失败清理，保留完整发布事务 | 新增存储介质或第二种发布策略 |
| [apps/api/src/dj/dj-script.service.ts:143](../../apps/api/src/dj/dj-script.service.ts#L143) `summarizeSearchActivity` | 29/12/3 | 逐条读取 Codex 研究事件，区分来源、引用和搜索进度；保留事件判别顺序 | 供应商事件协议新增种类 |
| [apps/api/src/dj/dj-script.service.ts:275](../../apps/api/src/dj/dj-script.service.ts#L275) `generateSegueScriptImpl` | 40/28/2 | 同处列出配置、目标、注入、密钥及执行时限入口条件，各条件直接返回错误分类 | 新增供应商或第二套前置配置 |
| [apps/api/src/dj/dj-script.service.ts:322](../../apps/api/src/dj/dj-script.service.ts#L322) `finish` | 53/11/1 | 单一子进程结束回调负责计时器、输出读取、合同校验、文件清理和一次性结算 | 第二个入口复用结果解析或增加输出格式 |
| [apps/api/src/dj/dj.controller.ts:77](../../apps/api/src/dj/dj.controller.ts#L77) `preview` | 17/7/4 | HTTP 状态由受限错误码分层映射，嵌套主要为状态表达式，合成生命周期已交流水线 | 状态映射被另一接口复用或再增加错误族 |
| [apps/api/src/dj/mp3-duration.ts:63](../../apps/api/src/dj/mp3-duration.ts#L63) `mp3Duration` | 17/11/2 | ID3/Xing 已提取；保留 MPEG 帧同步扫描、步进与合法性判断的一段算法 | 新增编码格式或帧恢复策略 |
| [apps/api/src/dj/pipeline-jobs.ts:26](../../apps/api/src/dj/pipeline-jobs.ts#L26) `createJobStore` | 164/1/0 | 闭包集中拥有任务表、复用键、活动会话、冷却和统计；每个内嵌操作独立计数 | 出现能独立拥有生命周期的新状态域 |
| [apps/api/src/dj/pipeline.ts:53](../../apps/api/src/dj/pipeline.ts#L53) `createDjPipeline` | 125/11/1 | 统一供应商依赖默认值、有效性门和两个公开入口；准备步骤已拆出 | 新增准备通道或入口生命周期 |
| [apps/api/src/http/static.controller.ts:28](../../apps/api/src/http/static.controller.ts#L28) `serve` | 30/11/1 | 一个静态请求中集中防目录穿越、文件选择、SPA 回退及 MIME 响应 | 增加静态资源后端或缓存协议 |
| [apps/api/src/listening/listening.controller.ts:129](../../apps/api/src/listening/listening.controller.ts#L129) `playStart` | 21/12/1 | 先验证 HTTP 文本，再集中应用可选元数据默认值和播放实例幂等写入 | 新增元数据组或另一个写入入口时抽共享请求 parser |
| [apps/api/src/music/music.controller.ts:105](../../apps/api/src/music/music.controller.ts#L105) `audio` | 32/13/2 | 流读取与取消已提取；此处只保留 Range、状态、媒体头转发分支 | 新增上游响应状态或转码协议 |
| [apps/api/src/music/netease.service.ts:80](../../apps/api/src/music/netease.service.ts#L80) `selectionLibrary` | 34/14/4 | 汇合红心与歌单、账号缓存和部分失败；完整性必须与同一快照绑定 | 新增曲库来源或缓存策略 |
| [apps/api/src/music/netease.service.ts:115](../../apps/api/src/music/netease.service.ts#L115) `discoveryCandidates` | 12/7/4 | 两类推荐来源用 allSettled 局部容错，嵌套为结果展开和去重 | 第三类推荐来源或独立排序策略 |
| [apps/api/src/music/netease.service.ts:277](../../apps/api/src/music/netease.service.ts#L277) `getUserPlaylists` | 47/12/3 | 分页偏移、去重与完整性同处判定，避免截断被当作完整曲库 | 上游分页协议变化 |
| [apps/api/src/music/netease.service.ts:332](../../apps/api/src/music/netease.service.ts#L332) `getPlaylistTracks` | 38/11/3 | 按歌单顺序重建详情并处理详情回退、缺失和完整性 | 新增歌曲详情获取策略 |
| [apps/api/src/persistence/db.service.ts:41](../../apps/api/src/persistence/db.service.ts#L41) `onModuleInit` | 58/7/2 | 启动时集中建立 schema、迁移旧表及索引；此次新增持久顺序列并验证旧库 | 下一次 schema 版本增加时提取版本化迁移 |
| [apps/api/src/preparation/discovery-selection.ts:42](../../apps/api/src/preparation/discovery-selection.ts#L42) `pick` | 39/17/4 | 按来源目标比例、近期限制和完整可播预算选取，分支共同决定同一批次 | 增加第三类来源或新的配比策略 |
| [apps/api/src/preparation/orchestrator.service.ts:111](../../apps/api/src/preparation/orchestrator.service.ts#L111) `runPrepare` | 62/28/2 | 保留候选、Codex、音源三段流程及每段失效门；每个供应商完成后检查会话和持久版本 | 新增第四阶段或多流程复用失效门 |
| [apps/api/src/preparation/orchestrator.service.ts:183](../../apps/api/src/preparation/orchestrator.service.ts#L183) `prepareBatch` | 53/12/2 | 同一入口完成会话有效性、版本拒绝、在途复用和 SSE 结算，状态归属唯一 | 增加跨进程任务调度或第二种批次类型 |
| [apps/api/src/preparation/preparation.controller.ts:34](../../apps/api/src/preparation/preparation.controller.ts#L34) `refill` | 64/23/3 | 集中登录前置、曲库读取、测试注入、准备调用及 HTTP 状态映射；原接口保持 | 新增请求字段组或第二种补歌入口 |
| [apps/web/src/features/player/Player.tsx:13](../../apps/web/src/features/player/Player.tsx#L13) `Player` | 73/11/3 | 单个播放器视图的状态文字、按钮禁用和时间展示；73 行低于组件 200 行基准 | 新增独立交互面板或状态文字被复用 |
| [apps/web/src/orchestration/radio-runtime.ts:87](../../apps/web/src/orchestration/radio-runtime.ts#L87) `createPlayback` | 101/3/1 | 一个播放器的事件注册表；外层计数含所有低复杂度回调，保留唯一媒体所有者 | 新增独立播放状态域；runtime 文件再次扩展时重新划分 |
| [apps/web/src/orchestration/refill-controller.ts:88](../../apps/web/src/orchestration/refill-controller.ts#L88) `<anonymous>` | 26/12/1 | 构造器列出可替换时钟、请求与事件依赖；复杂度来自默认值 | 增加非装配行为或多套依赖组合 |
| [apps/web/src/orchestration/refill-controller.ts:214](../../apps/web/src/orchestration/refill-controller.ts#L214) `check` | 14/11/1 | 集中判断是否有会话、播放意图、在途任务、退避与补歌阈值 | 新增补歌触发策略 |
| [apps/web/src/orchestration/refill-controller.ts:273](../../apps/web/src/orchestration/refill-controller.ts#L273) `handleResult` | 43/17/3 | 统一拒绝旧结果、失败退避、追加结果计数和状态通知 | 增加第三种批次结果或重试策略 |
| [apps/web/src/orchestration/segue-controller.ts:159](../../apps/web/src/orchestration/segue-controller.ts#L159) `setConfig` | 29/11/2 | 字段级配置约束及开关影响需与控制器状态同步 | 新增配置组或另一个入口复用约束 |
| [apps/web/src/orchestration/segue-controller.ts:196](../../apps/web/src/orchestration/segue-controller.ts#L196) `onTrackStarted` | 14/11/1 | 同次播放身份判断、计数和准备机会建立 | 新增歌曲开始事件来源 |
| [apps/web/src/orchestration/segue-controller.ts:222](../../apps/web/src/orchestration/segue-controller.ts#L222) `onQueueChanged` | 15/13/1 | 队列变更与当前机会目标逐项比对，决定是否作废 | 新增队列条目类型 |
| [apps/web/src/orchestration/segue-controller.ts:245](../../apps/web/src/orchestration/segue-controller.ts#L245) `onTrackEnded` | 46/28/1 | 集中表达结束时是否播放 DJ、等待任务或直接续歌的互斥决策 | 新增决定种类；届时拆出纯决策表 |
| [apps/web/src/orchestration/segue-controller.ts:352](../../apps/web/src/orchestration/segue-controller.ts#L352) `maybePrepare` | 51/17/1 | 同处判定准备条件、目标、顺序与重试身份，保证一次机会只提交一个身份 | 新增准备策略或机会触发来源 |
| [apps/web/src/orchestration/segue-controller.ts:407](../../apps/web/src/orchestration/segue-controller.ts#L407) `_onPrepareResult` | 33/15/2 | 旧请求、失败、未就绪及 ready 各分支都更新同一机会状态 | 新增服务端任务状态 |
| [apps/web/src/orchestration/segue-controller.ts:493](../../apps/web/src/orchestration/segue-controller.ts#L493) `snapshot` | 28/13/2 | 只读快照字段默认值和可用性判断；不改变控制器状态 | 快照字段成为多个视图各自独立的投影 |
| [packages/contracts/src/identity.ts:8](../../packages/contracts/src/identity.ts#L8) `makeTrackItem` | 19/15/1 | 旧歌曲格式归一化工厂，集中默认值和来源标记 | 增加旧格式版本 |
| [packages/contracts/src/job-validation.ts:11](../../packages/contracts/src/job-validation.ts#L11) `validateSegueJob` | 61/45/3 | 任务状态专属约束及机会/成品绑定一次累计全部错误 | 新增任务状态或复用状态子校验 |
| [packages/contracts/src/playback-events.ts:4](../../packages/contracts/src/playback-events.ts#L4) `validateEvent` | 26/17/2 | 按事件种类校验身份、自然结束证据与时戳，保留稳定错误码 | 新增事件大类 |
| [packages/contracts/src/queue-validation.ts:6](../../packages/contracts/src/queue-validation.ts#L6) `validateSegueAudio` | 12/15/1 | 同源地址、时长、资产身份和字节数构成一个媒体合同 | 新增音频格式或可用性阶段 |
| [packages/contracts/src/queue-validation.ts:19](../../packages/contracts/src/queue-validation.ts#L19) `validateQueueItem` | 37/25/2 | 两类条目及旧格式校验集中，成功值由唯一适配工厂产生 | 增加第三类条目 |
| [packages/contracts/src/samples.ts:150](../../packages/contracts/src/samples.ts#L150) `buildInvalidSamples` | 73/3/1 | 完整失败样例声明表，便于核对公开错误码 | 新增契约类别时分表 |
| [packages/contracts/src/script-validation.ts:12](../../packages/contracts/src/script-validation.ts#L12) `sources.forEach callback` | 24/14/2 | 单来源唯一性、链接、摘录及检索时间共用数组下标错误路径 | 来源成为独立输入或增加来源类型 |
| [packages/contracts/src/script-validation.ts:44](../../packages/contracts/src/script-validation.ts#L44) `validateScript` | 95/42/3 | 目标、故事、来源、陈述和长度五组规则累计全部字段错误 | 新增故事类型或重复规则组 |
| [packages/contracts/src/script-validation.ts:94](../../packages/contracts/src/script-validation.ts#L94) `claims.forEach callback` | 32/16/2 | 陈述唯一性、引用关系和民间说法口播归因需联合检查 | 陈述独立使用或新增类型 |
| [packages/contracts/src/transition-validation.ts:4](../../packages/contracts/src/transition-validation.ts#L4) `validateTransition` | 19/27/1 | 机会身份、顺序、状态和关闭元数据集中累计错误 | 新增身份维度或关闭状态 |
| [packages/contracts/src/transition-validation.ts:24](../../packages/contracts/src/transition-validation.ts#L24) `validatePrepareRequest` | 41/31/2 | 请求字段与有界上下文校验并归一化，保持错误路径 | 新增上下文子结构或复用字段组 |
| [packages/contracts/src/transition-validation.ts:73](../../packages/contracts/src/transition-validation.ts#L73) `jobMatchesPrepare` | 12/11/1 | 按优先级返回具体身份不匹配原因 | 增加排序或身份维度 |
| [scripts/browser/discovery.test.mts:12](../../scripts/browser/discovery.test.mts#L12) `test(真实浏览器：首批等待、来源记录、停止不误播、手动歌单后自动接回混合电台)` | 51/2/1 | 一条用户可见的端到端叙事，共用浏览器、媒体和事件记录；子阶段顺序是断言的一部分 | 新增独立用户场景时分为独立测试 |
| [scripts/browser/discovery.test.mts:15](../../scripts/browser/discovery.test.mts#L15) `http.createServer callback` | 23/22/2 | 本地 HTTP 替身完整路由表，所有路径在同一浏览器场景可见；不连接供应商 | 多个场景共享路由时提取带类型的路由模块 |
| [scripts/browser/migration.test.mts:62](../../scripts/browser/migration.test.mts#L62) `test(浏览器：连续歌曲→SSE就绪DJ→歌曲、补歌、暂停恢复与新会话)` | 72/3/2 | 一条用户可见的端到端叙事，共用浏览器、媒体和事件记录；子阶段顺序是断言的一部分 | 新增独立用户场景时分为独立测试 |
| [scripts/browser/migration.test.mts:69](../../scripts/browser/migration.test.mts#L69) `http.createServer callback` | 31/28/3 | 本地 HTTP 替身完整路由表，所有路径在同一浏览器场景可见；不连接供应商 | 多个场景共享路由时提取带类型的路由模块 |
| [scripts/lib/dev-runner.mts:10](../../scripts/lib/dev-runner.mts#L10) `runDev` | 118/8/3 | 一个开发子进程管理闭包，构建、重启与退出共享唯一服务句柄 | 新增编译器或第二服务进程 |
| [scripts/lib/library-checks.mts:17](../../scripts/lib/library-checks.mts#L17) `collectFailures` | 34/22/3 | 核对红心/歌单/来源/数量的一组诊断规则，每项输出具体失败 | 新增数据源或重复校验字段组 |
| [scripts/read-library.mts:37](../../scripts/read-library.mts#L37) `main` | 125/18/3 | 只读资料探针的逐阶段证据与错误收集；此次已补类型和缺登录态早退 | 新增写操作或另一种探针复用读取流程 |
| [scripts/tests/dev-command.test.mts:10](../../scripts/tests/dev-command.test.mts#L10) `test(dev：冷启动先构建，修改后重启，编译失败保留服务，退出清理子进程)` | 51/2/1 | 一次开发服务生命周期中的冷启动、重启、编译失败和清理，共享同一受控进程 | 新增独立启动方式时另建测试 |
| [scripts/tests/dj-pipeline.test.mts:387](../../scripts/tests/dj-pipeline.test.mts#L387) `test callback` | 25/13/2 | 阶段停止参数化回归按阶段读取对应调用数，保持供应商不得继续的断言 | 新增准备阶段时将期待表拆出 |
| [scripts/tests/segue-controller.test.mts:22](../../scripts/tests/segue-controller.test.mts#L22) `makeHarness` | 60/1/0 | 闭包封装可控时钟、请求和决策记录，防止跨测试共享状态 | 新增多种时钟或额外控制器域 |
| [scripts/tests/support/dj-pipeline-fixture.mts:24](../../scripts/tests/support/dj-pipeline-fixture.mts#L24) `makeDeps` | 56/1/0 | 一处提供时钟、三个供应商录制队列与清理 | 新增供应商阶段或其他 fixture 复用录制逻辑 |

## 复核方式

```sh
npm run check:quality
node scripts/check-quality.mts --out=/tmp/radio-quality.json
# 比较旧版本：在独立归档目录上扫描，无需更改当前工作区
node scripts/check-quality.mts --root=<独立基线目录> --out=/tmp/radio-quality-baseline.json
```

质量工具本身的测试覆盖纯注释/模板/正则/JSX、内嵌函数独立复杂度及 else-if/try-catch 的嵌套口径。它是可重复审查报告，不直接作为全仓硬门禁。

## 同日后续技术债修复（当前快照）

上面的 57 项为首轮整改后的历史快照；后续修复以 [技术债修复记录](./2026-09-20-technical-debt-repair.md) 为准。当前保留 51 项，没有新增超限；机器上限见 `docs/quality-baseline.json`，已移除恢复达标的 6 个例外，并下调仍保留项已改善的规模。

| 原例外 | 当前指标（有效行/复杂度/嵌套） | 处理 |
| --- | --- | --- |
| `runPrepare` | 30/10/1 | 候选、排序、结果交付及失效判定分开；移除例外 |
| `refill` | 32/7/2 | 提取输入适配、响应状态和测试注入；移除例外 |
| `onTrackEnded` | 25/9/1 | 播放身份、就绪资格与状态提交分开；移除例外 |
| `validateScript` | 21/10/2 | 目标、来源、陈述、长度职责分别校验，维持累计全部错误；移除例外 |
| `claims.forEach callback` | 已拆分且各部分达标 | 引用、归因与陈述身份分别校验；移除例外 |
| `validateSegueJob` | 17/8/1 | 身份、状态专属约束、成品及元信息分开；移除例外 |
| `prepareBatch` | 41/12/2 | 在途去重、结算与清理仍由同一入口持有；沿用原复评条件，不增加复杂度上限 |

来源选择的新模块及本次新函数均在基准内。其余保留例外仍按上表原有理由和触发条件复审，不表示技术债已全部清零。
