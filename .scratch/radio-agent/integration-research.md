# 外部接入核验

核验日期：2026-09-14。这里只记录事实与未验证项，不代替用户的功能决定。

## Codex（当前方案）

用户已明确用 Codex 订阅替换参考图中的 Claude Code。本机可执行文件为 `/Applications/ChatGPT.app/Contents/Resources/codex`，`codex --version` 为 `codex-cli 0.153.4`；`codex login status` 退出码为 0，经白名单识别为 ChatGPT 登录。当前命令环境没有非空的 `OPENAI_API_KEY`、`CODEX_API_KEY`、`OPENAI_BASE_URL`、`CODEX_ACCESS_TOKEN`、`CODEX_AUTH_TOKEN` 或 `CODEX_HOME` 覆盖；这不代表未来服务环境也完全相同。

[OpenAI 官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)说明 `codex exec` 用于程序化调用，默认复用已保存的 CLI 认证；[官方认证文档](https://learn.chatgpt.com/docs/auth)区分 ChatGPT 订阅登录与 API 按量计费登录。因此，本机个人电台使用官方 CLI 复用现有订阅有文档依据，不等同于取得可用于通用 OpenAI API 的订阅密钥。

本机 `codex exec --help` 与官方文档共同确认：

- `--json` 输出 JSONL 事件流，不是单个节目计划 JSON。
- `--output-schema <file>` 约束最终响应结构；`-o` / `--output-last-message` 可单独保存最终结果。
- `--ephemeral` 不保存会话 rollout 文件。
- `--ignore-user-config` 不加载用户 config.toml，但认证仍使用 Codex 的认证环境；具体运行隔离和模型选择尚未实测。

适配器应根据最终结构化结果提取节目编排和播报稿，不能沿用 Claude 的外层响应解析。未运行任何 Codex 模型请求，具体订阅档位、剩余额度、结构化结果、调用延迟与实际服务可用性仍待验证。

## Claude Code（历史核验，已由 Codex 替换）

本机只读检查发现 `/opt/homebrew/bin/claude`，版本为 `2.1.236`；帮助中包含 `-p`、`--output-format json`、`--json-schema` 和 `--tools`。认证状态白名单回读为已登录、`oauth_token`、`firstParty`；没有返回订阅档位，不能据此认定 Max。当前命令环境未设置 `ANTHROPIC_API_KEY`，未来服务进程仍需检查自己的环境。

[官方程序化调用文档](https://code.claude.com/docs/en/headless)明确支持 `claude -p`。图片中的 `--output json` 应按当前文档使用 `--output-format json`。此参数输出的是包含元数据的外层对象；要取得符合指定结构的业务对象，可结合 `--json-schema` 并读取 `structured_output`，不能把普通 `result` 直接当作 `{say, play, reason, segue}`。

[官方订阅说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)页面日期为 2026-06-16，顶部标注 `Update June 15` 的说明表示暂停原定额度调整，`claude -p` 与 Agent SDK 仍使用订阅额度；不应采用搜索摘要中已被该更新覆盖的旧方案。[个人使用说明](https://code.claude.com/docs/en/legal-and-compliance)提供了个人调用官方 Claude Code 的支持基础，不能据此承诺无限调用。

官方文档说明 `--bare` 不读取 OAuth 或系统钥匙串，因此不能在复用本机订阅登录时直接采用这个参数。实际调用组合仍需最小实测。

本次没有运行推理，尚未验证请求成功率、延迟、结构化输出、剩余额度或订阅档位。

## 浏览器开播

[Chrome 官方自动播放说明](https://developer.chrome.com/blog/autoplay)对有声自动播放设置条件，包括用户交互等。用户已在 Q5 确认自动准备节目、点击开播后才出声并连续播放；目标浏览器尚未实际验收。

## 音乐与语音

### 网易云音乐接口

[Binaryify 原 GitHub 仓库](https://github.com/Binaryify/NeteaseCloudMusicApi)于 2024-04-16 归档，README 声明停止维护。不过[原 NPM 包的发布元数据](https://registry.npmjs.org/NeteaseCloudMusicApi)仍显示 `4.32.0` 于 2026-05-18 发布，不能只根据仓库归档就断言原包全面停更。公开发布记录不证明接口实际可用。

[Enhanced 项目](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)是独立维护线，声明从原版 `4.28.0` 后自行维护；[NPM 包](https://registry.npmjs.org/@neteasecloudmusicapienhanced/api)为 `@neteasecloudmusicapienhanced/api`，公开版本 `4.40.1` 于 2026-08-18 发布，仓库要求 Node.js 22+。该项目包含额外音源等扩展行为，不能视为原包无差别替代品；本项目尚未选定具体维护线或启用这些扩展。

[接口文档](https://neteasecloudmusicapienhanced.js.org/)区分无需登录的搜索、依赖登录状态的个人数据和播放地址查询；提供二维码登录流程。歌曲搜索结果、播放地址和完整可播性是不同事实，须检查用户目标曲目的账号可用性、时长与浏览器实际播放。

### Fish Audio

[TTS API 文档](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)支持使用 API key，经 Bearer 认证调用 `POST https://api.fish.audio/v1/tts`，返回 MP3 等音频；可实现服务端合成、缓存、网页播放的参考流程。

[Quick Start](https://docs.fish.audio/developer-guide/getting-started/quickstart)区分声音 `reference_id` 与生成模型 `model`，也支持默认声音。实际中文串场效果与音色访问仍需试听核验。

[API 定价说明](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits)采用按量计费；[官网套餐 FAQ](https://fish.audio/plan/)关于会员与 API 访问的说明并不完全一致，不应把网页会员视为已经具备 API 额度。[模型说明](https://docs.fish.audio/developer-guide/models-pricing/models-overview)另列免费开发模型 `s2.1-pro-free`，受 fair-use 限制且没有首音频延迟保证；账户实际准入未知。TTS 文档表示省略或传入未知模型可能回落到 `s2.1-pro`，实现时需明确选择并校验配置。

本次未登录音乐或 Fish 账户、下载歌曲或调用 TTS，没有建立新服务账户或产生合成费用。随后仅检查当前进程环境的 `FISH_API_KEY` 与 `FISH_AUDIO_API_KEY` 是否非空，两者均未设置；没有读取或输出密钥值，也未扩展搜索其他凭据存储。这不能证明用户没有账号或额度。

## 用户提出的网易云 CLI

本机 PATH 中未找到 `ncm-cli`、`ncm`、`netease-cli` 等检查过的命令，当前 npm 全局包也没有对应工具。`npm view @music163/ncm-cli name version engines bin --json` 公开元数据返回版本 `0.1.7`、Node.js >=18、命令 `ncm-cli`。这是发布元数据检查，不是安装或调用。

[网易官方技能仓库](https://github.com/NetEase/skills)明确配套 `@music163/ncm-cli`。它使用网易云开放平台，要求 `appId`、`privateKey` 和用户登录授权，不是参考图中第三方 `NeteaseCloudMusicApi` 的命令行包装。用户尚未指定具体 CLI 项目；官方 CLI 是已找到的匹配候选。

[官方助手说明](https://github.com/NetEase/skills/blob/master/netease-music-assistant/SKILL.md)描述通过红心歌单分析偏好，也引用 `playlist collected` 读取收藏歌单。可优先验证这些音乐资料，再以实际可读字段确定口味输入；尚未读取用户账号。

仍未核实的能力：近期真实听歌历史、登录后的稳定 stdout JSON 合同、可直接用于网页播放的音频地址。文档中的 `ncm-history.json` 是已推荐歌单记录，不能当作听歌历史。CLI 本身的 JSON 格式能力已通过下述包源码检查确认，但不等于真实输出合同已经验收。

[官方 CLI 说明](https://github.com/NetEase/skills/blob/master/netease-music-cli/SKILL.md)中的 `play` 会控制播放器，内置后端是 mpv。由此推导的接入边界：读取音乐资料使用数据命令，网页继续承接已确认的收听体验；是否还能通过 CLI 取得网页音源须单独验证。当前仅核查公开资料，没有安装、配置、登录或执行播放。

### 官方 CLI 包源码补充核验

对 [@music163/ncm-cli 0.1.7 公开包](https://registry.npmjs.org/@music163/ncm-cli/0.1.7)内 `dist/index.js` 进行静态检查，未执行包代码或访问账号：

- `CommandRunnerSource._getLikedSongs()` 通过 `user favorite` 取得 `data.id` 或 `data.playlistId`，再用 `playlist tracks` 及 `playlistId / limit / offset` 分页读取；收藏和自建歌单对应 `playlist collected` 与 `playlist created`。
- 默认 `--output json` 直接序列化 API 响应，但查询命令及参数来自远端动态 manifest，manifest 信息通知可能混入 stdout。固定包版本仍需要登录后的命令、输出与分页样本验收。
- 内部 `getPlayUrl()` 请求 `/openapi/music/basic/song/detail/get/v2`，传入 `withUrl:true`，从 `data.playUrl` 取得 URL，并返回音质、时长和试听权限等信息。取音源在 mpv 的 `loadfile` 之前，是独立的内部操作。
- 尚未证明存在稳定公开的、无播放副作用的 CLI 音源查询命令，也未验证完整歌曲权限、URL 有效期及浏览器请求要求。不能通过调用 `play` 再截取 URL 来代替网页音源接入。

实施时应分别验收音乐资料读取和网页取音源、完整播放；公开包存在内部 URL 能力不等于真实网页播放链路已打通。

按同版本源码指定的默认位置，仅检查 `~/.config/ncm-cli/config.json` 和 `~/.config/ncm-cli/credentials.enc.json` 的存在性，两者均不存在；该范围内本机尚未配置 `appId` / `privateKey`。未搜索其他目录或读取凭据内容，不能据此判断用户是否拥有开放平台账号。

## 天气位置来源

[MDN Geolocation API](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API)说明网页可通过 `navigator.geolocation.getCurrentPosition()` 获取设备位置，但需要浏览器授权及安全上下文；授权或定位可能失败。文档还提示部分网络环境下的定位服务可用性存在限制，因此不能把“允许定位”当作“必定取得位置”。

[MDN 安全上下文说明](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)列出 HTTPS 以及可被视为可信的 localhost 等本地来源。定位可作为本地网页方案的候选能力，仍需在目标浏览器和网络中实测。

Q11 已确认：优先尝试定位，未授权或失败时让用户手动选择城市。尚未在实际 Radio 网页中验证；本次没有请求或读取用户当前位置。

## 飞书全天日程

本机 `lark-cli calendar +agenda --help` 与 [日历技能说明](/Users/nestor/.agents/skills/lark-calendar/SKILL.md)确认：`--start` 默认今天零点、`--end` 默认该日结束，`--calendar-id` 默认 `primary`。可查完整一天，包括已过日程；默认不自动合并所有订阅日历。个人日程以 `--as user` 查询。

[官方日程视图接口](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar-event/instance_view)按重复规则展开实例，要求对指定日历有读取权限；支持 `primary` 与 `shared` 类型，不支持 Google、Exchange。读取共享日历的可见事件，不等于这些事件都属于用户本人。用户已在 Q21 确认默认主日历、可在设置中选入其他可读取日历。

`+agenda` 文档说明过滤取消事件。[官方事件说明](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/introduction)使用 `start_time.date` / `end_time.date` 表示全天事项，因此应播为“全天”，不能误当作零点会议。跨天重叠、全天末日、拒绝或移除邀请的处理仍待实测。

本机帮助确认默认 JSON 输出，也支持 NDJSON 和 `--jq`；成功检查 `ok == true`，错误从 stderr 读取。日程视图接口不提供普通分页游标；查询跨度须小于 40 天，实例数达到限制时须按官方指引缩小窗口，不能把接口失败当作无日程。

只读认证白名单摘要为 `identity=user`、`verified=true`，但 `userStatus` 和 `tokenStatus` 为 `needs_refresh`。尚未刷新并查询实际日程，因此不能把接入标记为可用。本次没有读取真实日程正文、登录、授权或修改飞书数据。
