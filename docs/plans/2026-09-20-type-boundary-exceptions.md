# 类型边界与断言复审记录

日期：2026-09-20。对应代码规范整改计划 T6。范围为 `apps/api/src`、`apps/web/src`、`packages/contracts/src`、`apps/web/test` 和 `scripts` 的手写 TypeScript；不包含依赖和生成文件。此文是源码审查记录，不替代测试结果。行号用于定位，后续调整以符号名称为准。

复核命令：

```sh
rg -n '\bany\b|as unknown as' apps/api/src apps/web/src packages/contracts/src apps/web/test scripts -g '*.ts' -g '*.tsx' -g '*.mts' -g '*.cts'
rg -n ' as |require\(|JSON\.parse' apps/api/src apps/web/src packages/contracts/src apps/web/test scripts -g '*.ts' -g '*.tsx' -g '*.mts' -g '*.cts'
```

没有发现生产源码中的显式 `any`。这不等于所有外部输入均已校验：`JSON.parse` 和 CommonJS `require` 自身仍可产生隐式 `any`，而 `as string` 同样可能掩盖边界缺口。下文把局部适配依据与待处理缺口分开记录。`as const`、import/export 的 `as` 别名不是绕过输入校验。

## 显式 any 的全部保留位置

| 位置 | 用途和当前依据 | 实际运行校验及限制 | 复评条件 |
| --- | --- | --- | --- |
| `scripts/openapi-probe.mts:115`，`summarize` 的 `httpStatus/ms/json/raw` | 手动供应商协议探针把多个接口的原始结果打印到终端，不交给播放器或持久化业务。四个 `any` 均限定在这一参数对象内。 | `httpStatus/ms/raw` 由本函数所在模块构造；`json` 来自 `JSON.parse`，仅有解析失败捕获及 `Array.isArray`/`maskItem` 的对象检查，没有完整供应商 schema。不能称为已经验证的业务响应。 | 探针输出成为自动判定、写入业务状态或复用到服务端时，必须改为 `unknown` 并按所用字段读取；单独维护探针时也应收窄三个已有确定类型的字段。 |

整合复核时 `scripts/browser/migration.test.mts` 原 records/job/SSE/json 参数中的 any 已全部移除：生产合同通过 `typeof import` 加载，请求 JSON 先为 unknown，再由 `responseObject`、`playRequest`、`validatePrepareRequest` 收窄；observation 仅读取已检查字段。当前显式 any 只剩上述手动探针。真实 Nest/SQLite 兼容性另由隔离验证环境覆盖。

## 生产双重断言逐处说明

| 位置 | 保留依据与真实约束 | 复评条件 |
| --- | --- | --- |
| `apps/api/src/persistence/db.service.ts:125`，`fallback as unknown as string` | `getSetting` 缺行时原样返回 fallback；调用方立即 `Number(...)`，再 `Number.isFinite`，失败回到数值 fallback。没有把这个“字符串”输出给其它消费者。 | 改动设置存储接口时用 `getSetting(key)` 的 null 分支显式选择 fallback，或建立准确重载；若开始拼接/调用字符串方法则必须先移除此断言。 |
| `packages/contracts/src/script-validation.ts:150`，结果 `as unknown as SegueScript` | 校验器已经逐字段检查身份、文本、storyStatus、来源及 claims，并把 `targetTrackId` 写成 `toInt` 的数值结果；只有 errors 为空才成功。TS 不能把散落在数组错误收集里的验证自动还原成完整结构。 | `SegueScript` 新增或改变字段时必须同步校验和负例；若要减少断言，应按检查后的局部值构造返回对象，不能只删掉一层 unknown。 |
| `packages/contracts/src/transition-validation.ts:21`，结果 `as unknown as Transition` | 同函数验证必填身份、safe integer 的 epoch/transitionSeq、状态及可选关闭字段，返回前规范 targetTrackId；createdAt 采用历史 `Number(value) || 0` 兼容。身份水位经过实际校验。 | 新增字段时同步校验；createdAt 若参与排序、过期判断或对外要求有限时间，必须先拒绝 Infinity 等非有限输入。当前时间转换不是严格时间戳验证。 |

## 测试双重断言逐处说明

| 位置 | 保留依据、运行验证 | 复评条件 |
| --- | --- | --- |
| `apps/web/test/radio-runtime.test.cts:128/143/156` | `MockEventSource` 只实现生产连接生命周期实际使用的方法；类型断言把这部分能力装到测试全局 EventSource。相邻测试验证事件顺序、重连和关闭行为，不宣称替身实现完整 Web EventSource。 | 生产代码使用更多 EventSource 方法、静态属性或事件特性时，先扩充替身和行为测试，或改为注入小接口。 |
| `apps/web/test/runtime-settings-sync.test.cts:15` | 返回本测试事件对象的最小 EventSource 构造器；验证 settings 订阅行为。 | EventSource 使用面扩大时同上。 |
| `apps/web/test/support/runtime.cts:65` | 全局 document 仅提供 `getElementById`，返回受控 audio 替身；只用于 Node 编排测试。真实 DOM/音频能力由浏览器套件验证。 | 运行时开始访问其它 DOM API 时，改为注入端口或补替身，不允许把此 document 用于通用组件测试。 |
| `scripts/tests/audio-forward.test.mts:12/75` | NeteaseService 替身只实现该控制器路径调用的 `resolveTrack`，返回本文件固定 `ResolvedTrack`。测试分别走关闭前、背压、网络断开与正常响应路径。 | 控制器增加服务调用时必须先更新替身，优先让构造依赖采用小型 Pick 接口。 |
| 同文件 `:24/119` | `Sink` 或适配后的 Node HTTP 响应实现 audio forward 使用的 `write/end/on/off/destroy` 与头部方法；不是完整 Express Response。真实本机 HTTP 断开测试同时验证 socket 关闭到上游 reader/abort 清理。 | 音频路径依赖新的 Express 专属属性或方法时，复核替身，并保留真实本机 HTTP 测试。 |
| `scripts/tests/migration-http.test.cts:29` | Writable 提供流行为，对象补充控制器需要的 status/header/writeHead/body；断言仅存在于 response 工厂。`:17` 的单断言 `partial<T>` 先以 `Partial<T>` 检查提供的成员签名，再适配生产构造器。 | 新增控制器依赖或响应方法时更新工厂；完整 Nest 路由、装饰器、HTTP 解析不能只靠这些直接调用测试证明。 |
| `scripts/browser/discovery.test.mts:51` | pendingBatch 由 HTTP 回调赋值，等待循环已经确认非空后才调用；双断言绕过 TS 无法跟踪跨回调赋值的限制。 | 等待逻辑改变、可多次消费或需要取消时，改为明确 deferred Promise，避免用断言跳过 null 检查。 |

## 其它单断言按边界归类

以下覆盖剩余重复断言；相同用途不逐行复制。表内“已检查”仅指列出的字段和条件。

| 类别与代表位置 | 依据、检查位置与范围 | 复评条件 |
| --- | --- | --- |
| unknown→Record：`http-readers.ts:4`、`netease-boundary.ts:5`、`login-lifecycle.ts:12`、`radio-events.ts:13`、`api/client.ts:11`；合同 validator 的对象入口 | 先检查非 null/object（通用 HTTP/供应商 reader 还拒绝数组），再把成员视作 unknown；具体字段在随后的 string/number/boolean/array reader 或 validator 检查。Record 断言本身不声称成员已可信。 | 新增被读取字段时必须增加字段检查；不能把 Record 直接断言为最终 DTO。 |
| enum 检查中的断言：`playback-events.ts`、`queue-validation.ts`、`job-validation.ts`、`script-validation.ts` | 为 `includes` 的窄参数类型适配，真正判断由运行时集合成员检查完成。错误数组非空则返回 failure。 | 增加 enum 成员或增加新状态专属字段时同步合同与负例。 |
| 校验后的 DTO：`script-validation.ts:36` Source[]、`transition-validation.ts:54` 等字符串、`job-validation.ts:73` SegueJob | 每个 DTO 对应的字段/嵌套结构由本函数或 validateTransition/validateScript/validateSegueAudio 验证；成功返回使用已规范后的数值和嵌套结果。 | 合同定义扩展时逐字段复核。校验器被绕过或失败结果被读取时不再成立。 |
| 内部编排响应：`segue-controller.ts:419-439`、`radio-runtime.ts:270/503`、`refill-controller.ts:271-312` | 正常应用入口使用 `api` 的 HTTP parsers；ready 的 script/audio 又经 SegueController 验证。queue factory 负责构造内部条目。依赖注入的测试替身由对应测试负责提供有效结果。 | 新增直接供应商调用、worker、持久化恢复或绕过 api 的入口时，必须在新入口校验，不能沿用已有来源假设。 |
| Orchestrator 内部候选/opts/result：`orchestrator.service.ts:70/184/216/231-233` | 候选来自经过 Netease/Codex 校验的列表和内部 fixture；session 先查 open，epoch 交给数据库 safe-integer 水位判断；runPrepare 对缺省 library/count 等应用默认值。prepareBatch 的 Partial→完整 opts 是内部调用约定，不是通用请求校验器。 | 新增调用者、候选类型或必填 PrepareOptions 字段时，改为构造明确的规范参数，补入口负例。 |
| SQLite 行：`db.service.ts:94/113/120/169/183/209/294/320` 及 controller/service 中 session.id | 返回值来自固定 SQL、应用自身迁移/写入的 SQLite schema；查询投影/过滤保证字段名和来源 enum，缺行分支单独处理。adjustments 经 safeParse，HTTP 输出再经客户端 parser。没有逐行通用 schema 校验。 | 支持外部导入数据库、改变迁移、恢复未知旧数据或新增查询投影时重审；SQLite 的动态类型不能当作所有字段已校验的证明。 |
| Netease 模块桥接与嵌套作者：`netease.service.ts` 的 CommonJS api 类型、`:308` creator | 不提供 TS 声明的供应商模块被约束为异步返回 unknown；所有使用的 payload 经 netease-boundary。creator 的 nickname 已由 `playlist()` 检查才进入返回组装。 | 升级模块导出或读取新供应商字段时补校验；不能把 unknown 返回改为 any。 |
| DJ 子进程日志：`dj-script.service.ts:156-165` msg/item/action | 行以 `{` 开头且 JSON 解析成功后读取嵌套日志；可选链避免缺值，只有字符串 query 才进入最多五条、100 字的摘要。这里是日志观察，最终脚本另经 validateScript；嵌套断言不是完整日志 schema 校验。 | 日志开始驱动业务决策/自动执行，或供应商改为其它日志结构时，建立专用 unknown parser。 |
| Test hook 输入：`test-hooks.controller.ts:61-73/100-112` | 只在 `RADIO_TEST_HOOKS=1` 注册，fixture 环境隔离。mode/delay 等由注入实现消费；ID 列表有 Array.isArray+Number+有限值过滤。mode/code/message 并未完整验证。 | 任何钩子对常规运行开放、跨机器共享或消费不受控请求时，必须加严格请求校验；当前测试用途不能豁免生产路由。 |
| 只读浏览器快照：`browser-probe.mts:29-32`、`dj-smoke-browser.mts:22-25`、`orchestration-browser-adapter.mts:78`，browser 测试中的 JSON.parse observation | 快照由同次构建的 Player 生成，工具只读取 DOM。browser-probe 检查 queue/playToken，DJ adapter 检查 index/segue 存在；其余字段靠场景断言。orchestration adapter 为类型赋值，并无完整运行时 schema。它们没有生产控制入口。 | 工具与页面版本解耦、快照成为稳定外部协议或被外部系统消费时，定义共享 observation schema 并逐字段校验。 |
| DOM、timer 与 Node 平台：`radio-runtime.ts:89`、`refill-controller.ts:109`、`pipeline.ts:64`、`playback-snapshot.ts:7`、`verification-fixture.cts:35` | DOM ID/选择器由本应用固定模板提供；timer token 只回传给创建它的 timer 实现；Object.keys 来自本模块创建的快照；TCP listen 完成后 address 为 AddressInfo。运行时上下文而非用户 JSON 支撑这些断言。 | DOM 标签/ID、注入 timer 配对、快照构造或 listen 类型变更时重审。 |
| 错误处理：`(err as Error).message`、dev runner 的 `NodeJS.ErrnoException`、legacy-exception filter | 平台及本项目主要抛 Error，日志/提示消费 message/code；不少 catch 不含 instanceof，因此对任意抛出值没有严格保证。其依据仅限错误展示，不能用于可信业务分支。 | 接入会抛字符串/null 的依赖、发生错误处理再次抛错，或 code 参与决策时，改为统一 unknown 错误读取器。 |
| 本地构造的空数组/null、fixture JSON、泛型 clone/identity：`samples.ts:5/84-85`、`identity.ts:61`、fault-state、injection stats、fish-audio.test.mts:158` | 空值声明限定后续可赋值类型；samples 只克隆 JSON 兼容固定样本，identity 保持输入泛型；测试 JSON 来自同测试捕获的本地请求。没有将外部字节直接认可为业务对象。 | clone 用于 Date/Map/函数等非 JSON 数据、identity 类型变化或 fixture 来源变为外部时重审。 |
| 测试 CommonJS/TS 装载：`apps/web/test/support/runtime.cts:9`、测试中的 typed require | `_compile` 是仅测试 Node loader 使用的内部成员；生产模块导入用 `typeof import(dist/*.js)` 或导出的实际类型约束，构建声明后执行 tools typecheck。`require` 本身不会在运行时检查导出。 | Node loader API 或模块路径/导出变化时重新 build/types + 测试；不得以自制宽泛伪接口遮蔽签名变化。 |

## 审查发现与关闭记录

这些项最初发现时均缺少输入校验，已同步整合负责人并分别修正。下面记录当前校验位置和实际回归入口；历史不安全断言不作为保留例外。

| 位置 | 修复后的校验与行为 | 回归证据及复评条件 |
| --- | --- | --- |
| `apps/api/src/dj/audio-cache.ts`，`parseMetadata/readMeta/put/getMeta`，**已关闭** | 原先仅核对 assetId 并断言 bytes/durationMs；现从 unknown 检查对象、资产身份、正安全整数 bytes 与实际文件大小一致、正有限 durationMs、非负有限 createdAt、audio MIME，并拒绝磁盘中的 hit/corrupt 保留字段。getMeta 最后生成自身标志，put 使用已经收窄的元信息。余下 Record 断言位于 object/array guard 之后，其成员仍是 unknown。 | `scripts/tests/fish-audio.test.mts` 新增 16 个损坏元信息/重新发布场景，RED 14 失败、2 个已有身份校验通过；修复后全文件 41/41 通过，含正常复用、原子发布、并发同键、TTL 与容量保护。新增 metadata 消费字段、修改 MIME 或缓存格式时，扩展 parser 和负例。 |
| `apps/api/src/listening/listening.controller.ts`，**已关闭** | feedback 和 plays/start 改为 unknown 请求，isObject/hasOptionalText 在所有写入前校验文本及可空字段；sentiment 先检查 like/dislike。错误类型返回 400，原先的文本断言已移除。 | `scripts/tests/listening-input-http.test.mts` 通过真实 HTTP 覆盖对象/数组字段拒绝、旧反馈仍有效、非法播放请求不创建会话/播放记录。此处修复的是输入导致的部分写入，未声称消除所有数据库故障下的事务风险。 |
| `apps/api/src/music/music.controller.ts`、`NeteaseService.loadSession/getUserPlaylists`，**已关闭** | loadSession 用 identifier 验证本地 profile.userId；library 在调用供应商前检查正安全整数，无效账号返回 401；getUserPlaylists 入口也校验 uid。原 userId 数值断言已移除。 | `scripts/tests/migration-http.test.cts` 的“无效登录态账号不能传到供应商或作为曲库归属”回归；改动登录态持久化格式或账号身份来源时复评。 |
| `apps/web/src/orchestration/refill-controller.ts`，**已关闭** | setConfig 枚举 REFILL_DEFAULTS 的固定 key，拒绝非字符串/数值、空白、非 safe integer、负数；batchSize/maxAttempts 至少为 1；构造函数复用相同校验。双重 Record 断言已移除，剩余 Object.keys→keyof 仅基于本模块固定对象。 | `scripts/tests/refill-config.test.mts` 验证非法更新不覆盖确认配置、构造与后续更新约束一致。新增配置项时明确它的范围；若允许小数/负数，应按字段定义规则。 |

后续新增字段或入口时，按表中的复评条件检查。验证记录和最终验收结论以主整改报告为准。

## 同日技术债修复补充

`orchestrator.service.ts` 的空 Promise 双重断言已删除：先创建只含失效状态的对象，建立 Promise 后再合并并发布到在途表，异步流程仍读取同一对象。补歌成功/失败结果使用明确联合类型。

`preparation.controller.ts` 的 `null as unknown as string` 已删除：输入适配返回可选 sessionId，业务入口在收窄后才访问会话。以上两项不再是保留例外。本次来源选择、补歌错误提示也从 unknown 安全提取，其他边界按原表继续复审。
