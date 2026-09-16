# DJ 串场接入核验（任务 07）

状态：2026-09-17。目标是从「官方文档说支持」推进到「此电脑、此账户确实可用」。
本文件如实区分已验证与未验证；未取得凭据的项目保持未通过状态，不以替身结果冒充。

## 1. Codex 搜索与结构化稿（本机订阅）

**结论：已验证可用。**

环境：本机 codex-cli 0.153.4（`/Applications/ChatGPT.app/Contents/Resources/codex`），
调用方式与生产代码一致：`codex exec -c 'web_search="live"' --sandbox read-only --ephemeral
--ignore-user-config --output-schema <schema> --json -o <out>`（参数解析已于规格阶段核验）。

| 样例 | 目标 | brief 要点 | 结果 | 耗时 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | 周杰伦《晴天》 | 一般介绍 | sourced（documented claim：词曲编均为周杰伦） | 36s | 来源 LINE MUSIC 页面署名；4 次搜索事件、1 个被引用 URL |
| 2 | 陈奕迅《十年》 | 一般介绍 | sourced（documented claim：粤语原版《明年今日》） | 38s | 来源 Apple Music 专辑介绍 |
| 3、4 | 周杰伦《晴天》 | 明确要求民间说法 | 失败：`attribution_missing_in_script` | ~40s | 模型产出 unverified_account 但归因短语未逐字进稿；结构校验按契约拒绝，本次机会失败、不修稿 |
| 5 | 周杰伦《晴天》 | 明确要求民间说法（提示词修正后） | sourced，含 unverified_account claim | 52s | 稿中逐字归因「有乐迷在批踢踢论坛分享过一种听法……这是乐迷的感受」；来源为 PTT C_Chat 板真实帖子 |

核对要点：

- 搜索活动真实存在（每次 4 个 search 事件，query 样本与最终来源对应），不是模型自称「查到了」。
- 来源 URL 可回读、标题/署名/短摘录齐全；来源允许论坛/个人页面（样例 5 为 PTT），无官方白名单。
- 民间说法的归因文字逐字出现在播报稿正文中，不是只在元数据里标记（样例 5）。
- 样例 3、4 证明失败路径按预期工作：结构不过 → 本次机会失败 → 音乐照常；提示词修正后
  （要求 `spokenAttribution` 与正文逐字一致）样例 5 通过。这属于 02 模块的提示词修复，已进回归。
- 结构校验仍不能证明来源内容属实（如 PTT 帖子是否真为某乐迷所发、说法是否可靠）；
  「documented」只表示所读资料支持该陈述。真实性判断仍需人工核对。

原始产物：`verification/artifacts/dj-probe-1.json`、`dj-probe-2.json`、`dj-probe-5.json`
（含完整稿、claims、sources、搜索活动摘要；不含任何凭据）。

## 2. Fish 免费语音（s2.1-pro-free）

**结论：未验证。缺少实际凭据，不能宣称可用。**

- 本进程环境变量 `FISH_API_KEY` / `FISH_AUDIO_API_KEY` 均不存在（2026-09-17 只查存在性，未读取值）。
- 官方文档（2026-09-16 规格阶段只读回读）明列 `s2.1-pro-free` 为免费开发模型；实现已把
  `model` 请求头显式固定为该值，配置成未知值直接拒绝、不回落付费。
- 适配层与缓存的全部行为已用替身服务验证（见 `scripts/tests/fish-audio.test.mjs` 20 项：
  请求头/请求体、401/402/429 映射、错误正文拒绝、中断检测、时长解析、缓存键/淘汰/废纸篓）。
  这些只证明实现正确，不证明账户准入、免费额度与中文听感。
- 待用户提供 Fish 密钥（服务启动环境变量 `FISH_API_KEY`）后重跑：真实合成一条短稿 →
  记录时长与耗时 → 确认未产生费用路径。

## 3. 音色试听与选择

**结论：未完成，等待真实合成可用。**

- 网页已提供试听入口（停止收听时填写 reference_id → 试听 → 「设为正式音色」保存到本地设置），
  正式节目只使用已选定音色；候选试听不会自动覆盖已选音色。
- 本机无凭据，未进行任何真实试听；不存在「把默认声音当成已选音色」的情况
  （`djVoiceReferenceId` 默认为空 = 语音不可用，继续纯音乐）。

## 4. 用户待办（解锁剩余验证）

1. 在项目本地 `.env` 中填写 `FISH_API_KEY`（模板见 `.env.example`），然后用 `npm start` 重启；该启动命令会显式读取 `.env`，文件已被 Git 忽略。也可使用服务启动环境变量。
2. 重启服务后：`curl -X POST :8787/api/dj/preview -d '{"referenceId":"<候选音色>"}'` 或直接在网页试听。
3. 听感确认后在网页点「设为正式音色」，把结果记录回本文件。

在完成 1–3 前，任务 07 保持 `needs-info`；真实歌→DJ→歌验收（任务 08 真实阶段）保持未完成。

2026-09-17 配置排查：运行中 `/api/settings` 的 `djVoice` 返回 `ready:false`、缺少 `FISH_API_KEY`，正式音色为空；停止状态的 preview 预检返回 409 / `not_configured` / 未配置 Fish 密钥。页面现直接显示具体缺项及下一步，保存失败不再显示选音色成功，已有正式音色会回显。新增配置诊断与浏览器提示用例均先红后绿，全套 109/109；未调用真实 Fish，不代表合成已接通。

## 2026-09-17 真实试听恢复（覆盖上面的历史缺凭据状态）

- 已配置本机密钥。直连 Node fetch 复现 UND_ERR_CONNECT_TIMEOUT；启用 `--use-env-proxy` 后 Fish 可达。`npm start` / `start:test` 均启用环境代理，本机 `.env` 配置已存在的 127.0.0.1:7897 代理，并绕过 localhost/127.0.0.1/::1。
- 旧官方 E-Girl 示例 `8ef4a238714b45718ce04243307c57a7` 实际模型查询 404，合成返回 Reference not found；不再推荐。
- 从 Fish 当前模型列表选取候选「磁性电台女生」`213197c413fa4f158ca451b093914428`，通过实际 preview 接口成功合成 77739 字节、4859ms MP3，固定请求模型为 s2.1-pro-free。官方接口说明 https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech 当日仍列为免费开发模型；没有切换付费模型，未核对账户账单。
- 真实浏览器填入候选并点击试听，播放进度到 0:04 / 0:04，页面显示「试听结束」，「设为正式音色」可用。保留候选，由用户听感确认后保存，未自动更改正式音色。
- Fish/音频相关测试 23/23 通过，git diff --check 通过。本轮验证真实试听；正式歌→DJ→歌全链路仍未验收。

## 2026-09-17 串场未播排查与修复

现场浏览器自然结束计数已到 3，准备 2 次、失败 2 次；lastReason 为 Fish HTTP 400 / Reference not found。设置里正式音色仍是失效的旧 E-Girl ID。已通过设置接口改为真实试听成功的磁性电台女生 213197c413fa4f158ca451b093914428。

修复：失效 reference 单独归类 invalid_reference 并阻塞重复准备；更新音色清理客户端/服务端冷却；新配置为当前目标重新打开准备机会；异步任务完成通知界面，暂停也不会遗留“准备中”。新增两项回归先红后绿，全套111/111，diff检查通过。

真实浏览器验证（RADIO_TEST_HOOKS=0）：真实音乐音源、Codex 搜索写稿、Fish 免费模型合成；将前三首分别拖到末尾，由原生 ended 推进，不注入模拟 ready 或 ended。第三首断桥残雪期间完成准备；第三首结束后真实播出 Dreams/梦想天空分外蓝 的介绍，18.677秒、298839字节，segueId sg_mu4dqc1p126j3。播放器 kind=segue、paused=false、currentTime=11.01、自然结束计数归零、plays=1、failures=0。这是加速边界验证，不是连续完整听完三首。

DJ 在18.677秒自然结束，随后目标歌曲《梦想天空分外蓝》实际播放到20.53秒，kind=track、paused=false、准备1次/播出1次/失败0次。验收后在目标歌27秒处暂停，用户可点继续。
