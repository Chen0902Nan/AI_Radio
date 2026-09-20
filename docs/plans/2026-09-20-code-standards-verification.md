# 代码规范整改验收记录

日期：2026-09-20。对应 [执行计划](./2026-09-20-code-standards-remediation.md)。最终结果以本记录的实际检查表为准；离线验证和真实供应商能力分别陈述。

## 交付范围与版本

实施起点及最终 HEAD 均为 `61eb293bdc566cbfe8be27edcb22ca95ac19f403`，整改位于未提交工作区。本轮没有提交、推送、部署，也没有调用真实网易云、Codex 或 Fish。开始时已有 `AGENTS.md` 改动和未跟踪的代码规范、验证指南、整改计划；保留这些内容，仅同步本轮已经实施的命令、隔离方式与完成状态。

基线取该 HEAD 的独立 `git archive` 目录，离线安装依赖后执行。这样避开并行实施时新增失败用例对基线的影响：初始类型检查通过，干净基线全量测试 **163/163**、浏览器 **3/3**。运行版本遵循 `.nvmrc` 的 Node 24.16.0；生产与工具均严格 TypeScript 检查。

## T1–T9 结果与证据

| 任务 | 实施后的可观察结果 | 回归入口 |
| --- | --- | --- |
| T1 播放恢复 | 恢复操作绑定播放代次与条目；切歌、暂停、停止后旧拒绝不再影响新歌曲；当前失败仍提示，恢复不重复记账 | `apps/web/test/playback-controller.test.mts`、`runtime-resume.test.cts`、`radio-runtime.test.cts` |
| T2 DJ 设置与试听 | 已确认设置只有一个所有者；保存串行，旧 GET/SSE 不回滚新设置；试听具有独立代次，编辑、开播、停止或离开使旧结果失效；保存失败可见 | `dj-settings.test.cts`、`voice-preview.test.cts`、`runtime-settings-sync.test.cts`、浏览器 `dj-settings.test.mts` |
| T3 登录生命周期 | 二维码、轮询、过期刷新和跳转共用代次/取消信号，卸载全部清理，慢轮询不重叠 | `login-lifecycle.test.cts`、浏览器 `login.test.mts` |
| T4 请求顺序 | 真实开放会话检查，持久 `(epoch, transitionSeq)`；任务完成后仍拒绝旧请求，同键不同正文冲突；各阶段停止不继续供应商调用；更高 DJ epoch 使旧补歌作废，同 epoch 新机会不误取消补歌 | `dj-pipeline.test.mts`、`dj-order-http.test.cts`、`dj-stage-lifecycle.test.mts`、`refill-dj-epoch.test.mts`、`segue-controller.test.mts` |
| T5 音频转发 | 客户端在请求前、读取中、背压等待时断开，都取消上游并释放 reader/监听器；正常 Range/206 保留 | `audio-forward.test.mts` 包含真实本地 HTTP socket 断开，`migration-http.test.cts` |
| T6 输入与类型 | 供应商输入保持 unknown，逐字段解析；前端畸形 2xx 返回 invalid_response；共享 validator 成功值满足实际类型；生产 require 与 fixture 绑定真实声明 | `netease-boundary.test.mts`、`api-client.test.cts`、`program-contract.test.mts`、全仓 typecheck |
| T7 验证工具 | 六个 npm 验证入口与稳定性脚本已适配现有页面；数据库、登录态、缓存、Chrome profile 完整隔离；成功/失败均清理；外部服务模式修改前拒绝 | 各 `verify-*` 本地替身报告；`verification-environment.test.mts` 的准备/浏览器/报告故障、外部模式拒绝、目录哨兵与重启、派生进程继承管道检查 |
| T8 职责拆分 | 原六个大文件全部低于 500 有效行；React、运行时、任务监听、设置、记账、播放快照、供应商和验证场景按职责拆分 | 全量回归；[全部超限项处理表](./2026-09-20-code-quality-dispositions.md) |
| T9 可重复报告 | 新增 AST 质量报告，输出文件、符号及三个指标；不作为全仓硬门禁；全部原始项和新增超限项都有处置 | `npm run check:quality`、`quality-report.test.mts` |

T6 复审又关闭四个实际缺口：损坏缓存 JSON 不再被视为命中或伪造 hit/corrupt；非法播放/反馈文本在写库前返回 400，保留原反馈且不创建部分播放记录；非法本地登录态账号不传给供应商；补歌配置只接受已知字段的安全整数及字段范围，非法值保持原配置。对应 `fish-audio.test.mts`、`listening-input-http.test.mts`、`migration-http.test.cts`、`refill-config.test.mts` 均先复现失败再修复。

详细 DJ 顺序、旧库迁移及阶段证据见 [定向记录](./2026-09-20-dj-ordering-verification.md)。保留的类型断言、诊断工具 any 与复评条件见 [类型边界记录](./2026-09-20-type-boundary-exceptions.md)。

## 最终集中检查

| 实际命令 | 结果 | 证据范围 |
| --- | --- | --- |
| `npm run typecheck`；清理工具收尾后 `npm run typecheck:tools` | 通过 | contracts、web、api、工具/测试严格检查；先生成真实生产声明 |
| `npm test` | **290/290 通过**，0 失败、0 跳过 | 含完整构建、离线控制器/契约、真实临时 Nest/SQLite HTTP、断开清理与隔离故障测试 |
| `npm run test:browser` | **5/5 通过**，0 失败、0 跳过 | Chrome + 本地 HTTP/媒体，含登录 2 项、DJ 设置、混合选歌、连续歌曲/DJ/会话 |
| `npm run verify:playback` | **9/9** | 单曲失败、失败上限、自然结束和换歌 |
| `npm run verify:session` | **14/14** | 会话、反馈、进程重启持久化、浏览器暂停/恢复/刷新 |
| `npm run verify:codex` | **14/14** | 选歌字段、候选过滤、追加队列及 timeout/quota/invalid 降级；Codex 为替身 |
| `npm run verify:fixes` | **12/12** | 延迟恢复、故障切歌、登录态与缓存边界、只读曲库探针退出码 |
| `npm run verify:dj-smoke` | **13/13** | 歌曲/DJ/试听互斥、旧媒体事件和准备失败；文案/Fish 为替身 |
| `npm run verify:orchestration -- --skip-real` | **41/41** | 控制器 13、真实本地 HTTP 13、Chrome/媒体 15；真实供应商项明确未执行 |
| `node scripts/verify-stability.mts --duration-min=0.02 --sample-ms=300` | **9/9** | 短时采样、暂停/停滞检查和报告/清理入口 |
| `npm run check:quality` | 报告成功生成 | 152 个手写文件；见下节 |
| `git diff --check` | 通过 | 差异空白检查 |

工具收尾还复现并修复了 Chrome reporter/updater 继承 stderr 导致 Node 迟迟不退出的问题：浏览器关闭后显式销毁它的三个启动管道，服务进程同样在停止后释放管道。新增故障用例先 RED 后 GREEN，随后重新运行编排入口确认检查通过且进程正常退出；没有用 process.exit 掩盖残留资源。

七个验证脚本合计 **112 个检查通过**。它们使用自建本地替身环境；源码最终收口后另外复验了受缓存、请求文本与补歌配置修改影响的 session、DJ smoke 和 orchestration 入口。原始断言保留；集中检查发现的旧 fixture 缺字段/null 语义已修正并重跑通过。

## 质量报告与保留项

按同一 AST 工具比较干净基线与最终工作区：手写文件 **72 → 152**；大于 500 有效行的文件 **6 → 0**；任一函数指标超限 **80 → 57**；普通函数行数超限 **35 → 21**；圈复杂度超限 **62 → 44**；嵌套超限 **9 → 4**。没有组件超过 200 有效行。

原计划文本初筛只估计 4 个嵌套超限函数；AST 固定把条件表达式、try/catch 纳入控制流并排除内嵌函数干扰，得到基线 9 项，属于口径校准。质量工具测试同时覆盖模板字符串、正则、JSX 与纯注释，避免扫描器误计。

[逐项表](./2026-09-20-code-quality-dispositions.md) 含原始 80 项的去向和最终 57 项的实际指标、具体保留理由、复评条件。主要保留：唯一状态所有者的工厂闭包、累积全部字段错误的校验器、固定协议/算法判断，以及有明确顺序的测试叙事。新增字段校验令少数复杂度上升，已如实记录，没有把“移到新文件”描述为已降到阈值内。

## 验证边界和兼容影响

- 本地单元/接口测试、真实 Chrome 加本地媒体替身、真实供应商验收是三种证据。本轮只执行前两种；真实网易云账号/音源、Codex CLI、Fish 合成及线上部署均未验证。
- 稳定性脚本只跑最小短时采样，未执行默认 120 分钟观察；不能宣称长期播放稳定性通过。
- 准备请求新增必填 `transitionSeq`，旧客户端缺字段会收到校验错误。前后端和契约须同批交付；会话水位随 SQLite 持久保存，旧表缺列有迁移测试。没有改变“服务启动关闭遗留开放会话”的既有行为，也不会刷新后自动出声。
- 默认验证入口现在自建隔离替身服务；外部 `--base` 模式因不能完整恢复状态而拒绝。真实模式必须显式选择并提供已授权登录态，具体命令见 [验证指南](../agents/verification.md)。
- 编排探针校准了两处陈旧预期：不喜欢按 ADR-0005 硬排除；Codex 失败按现行合同降级续播。没有通过跳过场景或放宽关键不变量消除失败。网易云歌单与 DJ 媒体 fixture 补齐真实合同必填字段；手动历史的 null 来源按真实返回类型处理。
- 构建声明后再做工具类型检查，保证 CommonJS 测试导入不因缺声明退化；播放构建保留内部 `.js` 相对依赖，并生成兼容 `.cjs` 入口，避免拆分后运行时找不到模块。

可重复命令、质量定义和隔离路径已同步到项目文档。临时基线归档和诊断草稿在收尾移入废纸篓；本机最终验证 JSON 位于 `.scratch/verification/`，集中测试日志和基线/当前质量 JSON 保留在其 `code-standards/` 子目录，需要共享的结果已写入本文。
