# AI_Radio 项目约定

本文件补充项目特有约束。运行版本和命令以 `.nvmrc`、各包 `package.json` 为准。

## 业务不变量

- **播放归属**：浏览器持有队列并决定播放，服务端只准备内容。修改播放、补歌或 DJ 异步流程时，验证暂停后迟到结果不出声，停止或切换来源后旧请求不改变当前意图（ADR-0003）。
- **实际记账**：歌曲首次实际播放才记账，同一 `playInstanceId` 只记一次；手动歌曲和 DJ 不进入自动选歌比例统计（ADR-0005）。
- **契约一致**：跨端共用的业务结构在 `packages/contracts` 维护一份定义，局部结构留在所属模块。修改外部输入处理时，类型断言不能替代运行时校验。

## 代码质量

- 修改 TypeScript、组件或模块时，遵循 `docs/agents/code-standards.md`。

## 验证边界

- 按行为影响选择检查；文案修改不自动扩大为全套回归。选择测试或运行验证脚本前读 `docs/agents/verification.md`。
- 独立端口不代表数据隔离：运行 `verify:*` 前核对数据库、登录态和缓存路径；默认使用自建隔离服务与本地供应商替身，具体入口和真实模式要求见验证指南。测试钩子仅在 `RADIO_TEST_HOOKS=1` 时注册。
- 离线、浏览器替身和真实供应商验证分别报告；未执行的链路明确标注。

## 按需读取

| 任务涉及 | 先读 |
| --- | --- |
| 领域命名或架构调整 | `CONTEXT.md`、相关 `docs/adr/`；维护约定见 `docs/agents/domain.md` |
| 选歌、反馈或播放统计 | `docs/adr/0005-discovery-selection-history.md` |
| 工具或测试入口 | `docs/adr/0006-typescript-tools.md`（`.mts` / `.cts` 与严格类型检查） |
| HTTP 接口兼容性 | `docs/migration/route-contract.md` 是迁移基线，需同时核对现有控制器与客户端 |
| 运行配置或验收状态 | `docs/migration/data-config-paths.md`、`docs/migration/m5-verification.md`；历史报告不代替当前验证 |
| 技能要求建任务或分诊 | `docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`；`.scratch/` 仅本机使用，共享结论写入 `docs/` |
