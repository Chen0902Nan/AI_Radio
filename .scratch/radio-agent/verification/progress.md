# 第一阶段验证进度（音乐链路 + 最小播放器）

开始时间：2026-09-14 19:16 CST
范围：仅“读取真实账号音乐资料 → 获取有权播放的完整歌曲 → 本地网页播放”，含下一首与单曲失败换歌。

## 环境事实

| 项 | 值 |
| --- | --- |
| Node / npm | v24.16.0 / 11.13.0 |
| 机器 | macOS 26.6.2 (Darwin arm64) |
| 浏览器 | /Applications/Google Chrome.app |
| mpv | 未安装（官方 CLI 的 play 需要，本轮不使用） |
| ffmpeg | /opt/homebrew/bin/ffmpeg |
| Codex CLI | /Applications/ChatGPT.app/Contents/Resources/codex |
| Git | 仓库尚无任何 commit；AGENTS.md / CONTEXT.md / docs / .scratch 均为未跟踪。本轮不改动这些文件 |

## 最终采用的接入方案（本轮）

`@neteasecloudmusicapienhanced/api@4.40.1`（项目内本地依赖），只用标准只读接口：

| 用途 | 接口 | 备注 |
| --- | --- | --- |
| 扫码登录 | `/api/login/qrcode/unikey` + `client/login` | 用户手机扫码，cookie 存 `data/session.json` (0600) |
| 红心歌曲 id | `/api/song/like/get` | 一次返回全部 id，无分页 |
| 歌曲详情 | `/api/v3/song/detail` | 按 300 分块 |
| 收藏/自建歌单 | `/api/user/playlist` | limit/offset 翻页 |
| 歌单曲目 | `/api/v6/playlist/detail` trackIds + song_detail | 若 trackIds 少于 trackCount 则回落 playlist_track_all |
| 播放地址 | `/api/song/enhance/player/url/v1` (level=exhigh) | 不传 `unblock`/`match`，不启用任何替代音源 |

音源分类：`freeTrialInfo` 非空 → 试听片段；`url` 为空 → 无权播放；否则为完整歌曲。

## 第 2 步：本地最小服务（已实现）

- `server/netease.js`：接入层，凭据只在本进程使用；播放地址带 20 分钟有效期的内存缓存。
- `server/index.js`：HTTP 服务，静态页 + JSON API + `/api/audio/:id` 音频转发（转发 Range，前端永远拿不到 CDN 直链）。
- `public/`：最小播放器（歌曲信息、播放/暂停、下一首、状态提示、列表）。
- 故障注入：`RADIO_TEST_HOOKS=1` 时开放 `POST /api/_test/fail-next`，只影响解析步骤。

### 机械链路冒烟（游客态，不作为最终证据）

- 首页加载后不自动出声；未登录时明确提示去 `/login`。
- headless Chrome（系统 Chrome + puppeteer-core）能真实解码播放：6 秒墙钟推进 5.85 秒，`duration` 与真实曲目 288.66s 一致。

## 步骤 1：官方 CLI 接入前提核实（已完成核查，受阻）

- 本地安装 `@music163/ncm-cli@0.1.7`（项目内 `node_modules`，未改全局）。
- `ncm-cli --version` → `0.1.7`。
- 未配置凭据时，任何命令（含 `--help`）都提前退出：
  `[错误] API key 未设置` → 要求 `ncm-cli configure` 或 `config set appId/privateKey`。
- 用临时 HOME（`/tmp/ncmcli-probe`，不污染真实 `~/.config`）写入假凭据后：
  - 配置文件实际是 `~/.config/ncm-cli/credentials.enc.json`（加密），另有 `update-check.json`、`app.log` 和 `~/.netease_mcp_device.json`。
  - `ncm-cli --help` 与 `ncm-cli commands` 只列出静态命令：play/pause/resume/stop/next/prev/seek/volume/queue/state/login/logout/tui/configure/upgrade/config/cloudupload/cloud/diag。
  - **search、playlist、user favorite 等资料命令不在静态列表**，来自远端动态 manifest，需有效 appId/privateKey 才能注册。假凭据下未注册。
- 结论：官方 CLI 路径的硬性前提是**网易云音乐开放平台入驻**（README 指向 developer.music.163.com 个人入驻）取得 appId + privateKey，再用手机扫码登录。本机无此凭据，无法继续。属于用户侧阻塞项，不是失败结论。
- 未验证（因缺凭据）：动态命令的真实输出、分页、以及 `getPlayUrl` 返回的 playUrl 是否为完整歌曲（源码静态检查显示 `withUrl:true` 取 `data.playUrl`，但权限/时长/试听边界未证实）。

## 状态：本轮验证已完成

最终结果见 [report.md](report.md)。摘要：

- 真实读取：红心 456 首（去重后 456，详情 456/456），歌单 4 自建 + 2 收藏，曲目全部取全。
- 真实浏览器：14/14 检查通过，含一首完整歌曲自然播完（260.0s 曲目 / 260.0s 墙钟，ended 于 259.99s）。
- 故障恢复：注入单曲失败 → 1.2s 退避后换歌；连续 3 首失败 → 停止快速重试。
- 真实无权限曲目（残酷月光）被明确标记并跳过。
- 未验证：试听片段分支（账号是 VIP 未遇到）、播放地址过期刷新（无法真实构造）、官方 CLI 音源能力（缺凭据）。

## 后续计划（已更新）

1. 如需回到官方 CLI 路线，需你本人先完成网易云音乐开放平台个人入驻（appId + privateKey）。
2. 播放地址刷新路径仍缺一环真实失效地址的验证，可用本地可控代理补。
3. 进入后续开发前，把“音源解析 + 待播队列 + 失败策略”收敛成编排层可复用接口，避免第二套并行实现。

## 附加：代码审查修复（2026-09-15，两轮）

代码审查先后指出两类缺陷，均已修复并补回归验证，详见 [report.md 第 7 节](report.md)：

第一轮：

- A/B 播放器竞态：旧解析请求覆盖新选择；加载中暂停又被迟到结果拉起。用 `playToken` 代次号 + `userWantsPlayback` 修复。
- C 音源缓存：退出登录/刷新确认不可播放后仍命中旧地址。缓存改为绑定身份 + 无地址时删除条目 + 登录态变更清空。
- D 资料读取脚本误报成功：失败状态没传出退出码。判定逻辑抽到 `scripts/lib/library-checks.mjs`，失败时退出码非零。

第二轮（播放控制残留）：

- P1 切歌加载中暂停后恢复会退到旧歌。新增 `loadedSrcId()`，只在播放器里装的就是当前曲目时才直接续播。
- P2 失败后的自动换歌定时器会切走用户手动选的歌。定时器记住触发时的代次，代次变了就不再执行。
- P3 暂停后到达的媒体错误会因地址刷新成功而自动出声。`refreshCurrent()` 仍刷新地址，但只在用户想播时才 `play()`。

敏感性验证：把修复临时回退后，对应检查均稳定失败；恢复后全通过。

最终回归：`read-library` 退出码 0（failures 为空）、`verify:playback` 14/14、`verify:fixes` 18/18。

## Codex 选歌最小验证（2026-09-15）

- 接入：本机 `codex-cli 0.153.4` 子进程，复用 ChatGPT 订阅；`--output-schema` 约束结构、`-o` 取最终消息、read-only 沙箱、空工作目录、`--ignore-user-config` 降上下文。
- 真实调用：exit 0、12.4～13.1s、22,711 tokens（提示词含着 60 首候选）。
- 结果校验：id 必须在候选集、不重复、有理由；部分非法只保留合法部分；全部非法判为 invalid_output；进队列前再用真实账号查一次可播性。
- 浏览器：接入队列不打断当前播放，原曲留队首，Codex 选的歌接在后面，并能真实播放其中一首。
- 失败续播：timeout / quota / invalid_output 三种注入下，队列与播放均不受影响。
- 敏感性：把失败分支改成一清空队列、去掉 id 校验后，5 项检查稳定失败；恢复后 13/13 通过。

详见 [report.md 第 8 节](report.md)。

## 记录

- 详见 [../../integration-research.md](../integration-research.md) 的既有只读核查。
