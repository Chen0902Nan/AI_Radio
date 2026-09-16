# 01 · 固定节目条目、来源与串场状态契约

Status: ready-for-agent
Type: task
Depends on: 无
Execution: done
确认依据：Q9 已整体确认，无未决需求。

## 目标

让歌曲与 DJ 成为可区分的节目条目，前后端能一致判断一个播报是否属于当前会话、当前机会和下一首歌曲。输入：[开发契约](../contract.md)、[规格](../spec.md)。

## 范围与输出

- 实现轻量共用校验模块（可沿用 `public/orchestrator.js` 的浏览器/CommonJS 双端形式），固定节目身份、准备请求、成品、来源、失败状态及事件形状。
- 区分 `itemId`、`trackId`、`transitionId`、`segueId`、`playInstanceId`、编排 `epoch` 与播放 `playToken`，明确旧纯歌曲结构的适配边界；暂停恢复保留播放实例，重新开始则新建。
- 定义 `documented/unverified_account`、事实/说法到来源的引用、实际播出归因和 `basic_only` 结果。
- 为 02–06 给出最小有效样例及失败样例；样例不包含真实账号凭据。
- 输出独立模块、必要单元测试及契约的最终字段补充；模块文件建议 `public/program-contract.js`，测试放 `scripts/tests/program-contract.test.mjs`。

## 验收

- 相同 `trackId` 的两次入队保留不同 `itemId` 和机会；播报没有伪装成歌曲数字 ID。
- 空稿、跨目标结果、缺失来源引用、不合法状态及错误字段被明确拒绝；允许论坛/个人来源。
- `unverified_account` 要求实际文案含对应归因，不只在隐藏元数据标记；验证边界明确说明不能程序性证明来源内容属实。
- 例子足以让文案、TTS、客户端控制和接口工作流独立开发，不要求先接真实服务。

## 边界

不重构整个播放器、不新增服务端播放队列、不实现模型/TTS调用。这里的测试覆盖输入合同和容易混淆的身份，不为每个常量机械写测试。

## Comments

- 2026-09-16：任务草案；确认后先交付本项，作为并行工作共同输入。
- 2026-09-16：用户已确认“确认，按此编排”。本项已具备开发条件，为首个执行入口；尚未开始实现。
- 2026-09-17：已交付。`public/program-contract.js` 提供身份工厂（makeTrackItem/makeSegueItem/makeTransition/closeTransition/transitionKey）、准备请求/来源/文案/任务/事件/决定校验、播放实例登记（playInstanceId 复用与新建语义）、时长估算与 02–06 使用的有效/失败样例；契约补充：稿长默认 50–140 字（15–30 秒）、来源摘录 ≤400 字、brief ≤200 字、stale 原因枚举。测试 `scripts/tests/program-contract.test.mjs` 29 项全绿；全仓 `npm test` 32 项通过。文档已注明结构校验不能证明来源内容属实。
