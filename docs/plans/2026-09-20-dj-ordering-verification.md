# DJ 顺序、契约与职责拆分定向验收

2026-09-20；工作区变更，未提交、推送、部署或调用真实供应商。本记录仅覆盖整改计划 T4、T6 的共享契约部分，以及 T8 的契约和 DJ 流水线；全仓验收以主验收记录为准。

已先新增并运行两个失败回归：最新任务完成后旧请求仍被接受、工厂入口不核验开放会话；旧实现为 18 通过 / 2 失败。修复后新增缺序号、同序号不同正文、各准备阶段停止、刷新顺序恢复与旧库迁移/持久化的覆盖。

实际执行：

```sh
npm run build -w @radio/contracts
npm run build -w @radio/api
npm run build:playback -w @radio/web
node --test scripts/tests/dj-pipeline.test.mts scripts/tests/dj-order-http.test.cts scripts/tests/segue-controller.test.mts scripts/tests/program-contract.test.mts
```

结果 82/82 通过，0 跳过。HTTP 测试使用临时 SQLite、独立音频和登录态路径，以真实 Nest HTTP 入口核验不存在/结束/不匹配会话、缺失顺序、相同请求幂等、同序不同内容冲突、旧版本/旧机会拒绝、重新建立服务实例后持久顺序仍生效、新会话不受旧记录影响。旧数据库没有顺序列时自动兼容初始化。测试通过缺少音色配置在供应商调用前结束，供应商入口另外设置为失败断言。流水线替身覆盖目标解析、文案、合成、缓存四阶段停止后不继续后续阶段、不发布 ready。

`validateQueueItem` 通过工厂返回完整规范化条目，数字字符串 ID/时长不会以错误实际类型泄漏。准备入口严格要求安全整数 epoch/transitionSeq；文案目标 ID、任务时间和嵌套成品分别规范化或检查。根入口保留公开导出；拆分后的源码使用显式 `.js` 相对引用，同时满足 CJS、ESM 和 NodeNext 声明解析。

DJ 服务拆成 Nest 装配、请求顺序门、任务状态存储、研究/合成/发布步骤。会话顺序和任务状态各有一个持有者。准备步骤在每个 await 后回到统一有效性检查。

## 复杂度保留说明

质量报告的工厂外层有效行包含内嵌方法体，因此 `createJobStore` 和 `createDjPipeline` 仍超过普通函数行数基准。它们分别封装任务状态和依赖装配；继续拆开会将共享可变状态暴露给多个所有者。保留闭包归属；当新增独立状态域或功能步骤时再抽独立对象。研究/合成/发布已按阶段拆分，不以压行降低指标。

共享校验器（`validateTransition`、`validatePrepareRequest`、`validateQueueItem`、`validateSegueAudio`、`validateScript`、`validateSegueJob`、`validateEvent`）目前仍集中列出结构字段规则并一次返回全部错误，分支数由独立字段约束叠加产生。保留逐字段错误路径和稳定错误码的可审查布局；今后新增字段组或重复规则再抽独立校验步骤。`buildInvalidSamples` 为完整失败样例声明表，保留同处核对错误码；新增一类契约时按类别拆表。本轮没有把这些例外描述为已降到阈值内；最终指标由 `npm run check:quality` 统一记录。

本定向报告不证明真实网易云、Codex 或 Fish 可用，不代替最终全量/浏览器回归。实际服务启动仍沿用关闭遗留开放会话的策略；服务实例重新装配测试验证持久顺序，不代表重启后自动恢复播放。

## 编排工具迁移（T7）

`verify:orchestration` 入口保留并改为默认完整本地替身模式，使用统一 `withVerification` 临时数据库、独立登录态、音频缓存、Chrome profile 与报告路径。外部服务模式由统一入口在修改前拒绝；真实模式必须显式 `--real --session-file=...`。外层统一负责关闭浏览器/服务和移动临时目录，阶段不再自行恢复不属于它的环境。

控制器用例按阈值、退避、取消、换会话、未发请求、重复结果分别组织；HTTP 用例按顺序、排除、降级/冷却和停止组织；浏览器按自然续播、播放意图、刷新/恢复、耗尽组织。所有旧可观察场景保留，去掉旧 `window.__radio` 和旧 DOM id；浏览器读取 `data-radio-observation`、媒体状态和隔离数据库，以页面按钮执行操作。需要小队列的场景只调整该页收到的曲库 HTTP 响应，再点击可见来源按钮；没有恢复任意改写生产状态的全局接口。

实际运行 `node scripts/verify-orchestration.mts --skip-real`：41/41 通过，包含 13 个控制器检查、13 个真实 HTTP 检查、15 个 Chrome/媒体替身检查。报告 `.scratch/verification/orchestration.json` 为本机产物；真实供应商调用明确未验证。自然跨批场景没有 seek 或改播放速率，核对真实 ended、媒体时长和墙钟耗时；其余需要推进歌曲的场景单独标明 seek。

迁移后的失败探针还确认两处既有分类缺口：冷却期被报告为 `codex_skipped`，全部音源查询抛错被报告为 `no_playable`。保留原接口断言后先得到 2 项 RED，再修复为 `codex_cooldown` 和 `music_unavailable/503`；候选均为试听/不可播时仍为 `no_playable`。浏览器又确认补歌设置未应用、初始开放会话未恢复；由运行时整改统一修复后原场景通过。

三个契约/DJ/串场测试入口的 CommonJS 生产导入均绑定 `typeof import`；可控 Promise、请求参数、供应商输出、取消/事件记录均有显式类型。无效文案 fixture 用新对象表达不合法外部输入，不把生产类型放宽。就绪后的媒体字段非空断言由相邻公开任务状态/结果断言支撑；通用任务读取 helper 先执行运行时存在性断言。

逐符号保留理由（指标以最终 AST 报告为准）：

| 符号 | 保留的具体职责 | 重新评估条件 |
| --- | --- | --- |
| `createJobStore` | 闭包内统一拥有任务表、复用键、活跃会话、冷却与统计；外层行数包含所有内嵌方法 | 出现可以独立拥有生命周期的新状态域 |
| `createDjPipeline` | 集中装配可替换供应商依赖和对外准备/试听入口，分支主要是依赖默认值 | 新增独立准备通道或入口生命周期 |
| `makeDeps`（DJ 测试 fixture） | 一处提供可控时钟、三个供应商录制队列和清理方法 | 新增准备阶段或多个 fixture 复用相同录制逻辑 |
| `makeTrackItem` | 旧歌曲格式归一化工厂，同处列出默认值和来源标记，避免各客户端自行解释 | 添加新的旧格式适配版本 |
| `validateTransition` | 身份、顺序、状态和关闭元数据一起累计错误，并检查会话/版本匹配 | 新增另一类机会身份或关闭状态 |
| `validatePrepareRequest` | 准备请求全部字段规则和有界文案上下文归一化，返回稳定字段错误路径 | 增加新的上下文子结构或字段组复用 |
| `jobMatchesPrepare` | 有优先级的身份不匹配原因清单，每项即时返回具体原因 | 新增排序/身份维度，需要共享结构化差异 |
| `validateQueueItem` | 两类队列条目与旧格式拒绝集中说明；成功分支使用唯一适配工厂 | 增加第三类条目时按类型独立校验 |
| `validateSegueAudio` | 同源媒体、时长上限、资产标识及字节数共同构成媒体可用契约 | 增加其他音频格式或可用性阶段 |
| `validateScript` | 目标身份、故事类型、来源、陈述、长度五组约束一次累计全部错误；调用方依赖细分错误码 | 新增故事类型或重复使用陈述/时长规则时提取具名字段组 |
| `validateSources` 的逐来源回调 | 每个来源的身份唯一性、链接、摘录、检索时间同处检验并保留数组下标路径 | 来源成为独立 HTTP 输入或出现新的来源类型 |
| `validateScript` 的逐陈述回调 | 陈述身份唯一性、来源引用与民间说法口播归因必须联合检验 | 陈述结构独立使用或新增陈述类型 |
| `validateSegueJob` | 四类任务状态专属约束与机会/成品绑定检查一起累计全部错误 | 新增任务状态或多个入口复用状态子校验 |
| `validateEvent` | 按事件种类要求媒体身份、自然结束标识和时戳，保留稳定事件错误码 | 增加新的事件大类 |
| `buildInvalidSamples` | 完整失败样例声明表，便于核对每个公开错误码及样例 | 新增契约类别时按类别分表 |

本轮已进一步拆出任务终态统计、研究参数构造、自然结束证据计算，并把控制器探针分成六个可独立检查的命名步骤；这些新步骤不再超限。

## T4 共享 epoch 跨通道收口

新增 `scripts/tests/refill-dj-epoch.test.mts`，经公开 `prepareBatch` 与真实临时 SQLite 服务，在候选读取、Codex 选歌、音源校验三个供应商边界暂停补歌，再通过 `acceptDjRequest` 推进会话持久顺序。首个用例得到真实 RED：旧补歌仍成功返回，缺少预期 `superseded`。最小修复让补歌每次有效性检查同时读取持久 `highest_epoch`；更高版本使旧批次及后续供应商调用作废，同 epoch 的新 `transitionSeq` 不阻断补歌。

定向命令 `npm run build -w @radio/api` 通过；`node --test scripts/tests/refill-dj-epoch.test.mts scripts/tests/dj-order-http.test.cts scripts/tests/dj-stage-lifecycle.test.mts` 共 9/9 通过，其中跨通道测试 6 项覆盖三个阶段的更新版本作废及同版本继续。`npx tsc -p tsconfig.tools.json` 通过。测试只控制外部供应商适配器，使用隔离数据库、登录态和缓存路径，未调用真实供应商。
