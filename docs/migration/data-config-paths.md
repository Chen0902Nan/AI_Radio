# 数据、配置与路径清单（M0 冻结基线）

迁移时必须逐项保留覆盖方式；编译到 dist 后路径必须仍指向项目根 `data/`，不得默默创建空库或丢失登录态。

## 1. 文件系统路径

| 路径 | 用途 | 覆盖方式 | 迁移要点 |
| --- | --- | --- | --- |
| `data/radio.db`（+ `-shm`/`-wal`） | SQLite 四类表：settings / feedback / sessions / plays | `RADIO_DB_FILE` 环境变量（`server/db.js:16`） | M2 不改 schema；WAL 场景不能只复制主文件做备份 |
| `data/session.json` | 网易云登录 cookie + profile（chmod 600） | 无（固定路径，`server/netease.js:27`） | 路径从 `__dirname` 相对推导；dist 后必须仍指项目根 |
| `data/ncm-tmp/` | 上游包的 anonymous_token、xeapi_public_key 镜像（重启免重新注册） | 无 | 随 DATA_DIR 走 |
| `data/dj-audio/` | DJ 音频缓存（64 位十六进制资产名 .mp3/.json） | `DJ_AUDIO_CACHE_DIR`（`server/dj-audio-cache.js:23`） | 淘汰只移入废纸篓 |
| `data/openapi-cred.json` | 历史官方开放平台凭据（ADR-0002 后未使用） | 无 | 不读取、不删除 |
| `/tmp/radio-codex-*`、`/tmp/radio-dj-*` | Codex 子进程临时工作目录（用完即清，rmSync 允许：非用户数据） | 无 | — |
| `~/.Trash`（退回 `<dir>/.trash`） | 缓存淘汰与测试清理的废纸篓 | 无 | 绝不自动清空 |

## 2. 环境变量

| 变量 | 默认 | 消费者 | 语义 |
| --- | --- | --- | --- |
| `PORT` | 8787 | index.js | 监听端口 |
| `HOST` | 127.0.0.1 | index.js | 默认回环监听，单机单入口 |
| `RADIO_TEST_HOOKS` | 未设置 | index.js / codex.js / netease.js / fish.js / dj-script.js / dj-pipeline.js | `=1` 注册测试钩子并启用注入分支；正常启动不得注册 |
| `RADIO_DB_FILE` | `data/radio.db` | db.js | SQLite 覆盖路径（验证脚本用它隔离数据库） |
| `DJ_AUDIO_CACHE_DIR` | `data/dj-audio` | dj-pipeline.js → dj-audio-cache.js | 音频缓存覆盖路径 |
| `DJ_SCRIPT_TIMEOUT_MS` | 90000 | dj-script.js / dj-pipeline.js | 文案阶段超时 |
| `FISH_TTS_TIMEOUT_MS` | 60000 | fish.js / dj-pipeline.js | 合成阶段超时 |
| `FISH_API_KEY` / `FISH_AUDIO_API_KEY` | 无 | index.js → dj-pipeline | Fish 密钥，仅服务进程内存，不入库不下发 |
| `FISH_API_BASE` | `https://api.fish.audio` | fish.js | 合成 API 地址 |
| `CODEX_BIN` | `/Applications/ChatGPT.app/Contents/Resources/codex` | codex.js | 本机 Codex CLI 路径（ADR-0001） |
| `CODEX_TIMEOUT_MS` | 90000 | codex.js | 选歌子进程超时 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 无 | 启动命令 `--use-env-proxy` | 代理由 node 启动选项统一处理，不是模块内配置 |

`.env` 由启动命令 `node --env-file-if-exists=.env` 显式加载（根目录）；迁移后必须在 Nest bootstrap 里保持等价行为（存在才加载、不覆盖已有进程环境变量）。前端仅允许公开配置，任何密钥不得进入浏览器包。

## 3. 运行入口

| 命令 | 行为 |
| --- | --- |
| `npm start` | `node --env-file-if-exists=.env --use-env-proxy server/index.js` |
| `npm run start:test` | 同上 + `RADIO_TEST_HOOKS=1` |
| `npm test` | `node --test scripts/tests/*.test.mjs`（离线，无外部服务） |
| `npm run verify:*` | Puppeteer 回归脚本（需要 Chrome、登录态或独立服务） |

迁移期间保留旧入口可回滚；新入口不得与旧入口同时对真实库执行启动收尾（`closeStaleSessions`）。
