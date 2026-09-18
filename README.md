# AI Radio

## 开发启动

使用 Node.js 24.16.0；首次拉取项目后先执行 `npm ci`。在项目根目录运行：

```sh
npm run dev
```

打开 http://127.0.0.1:5173 。命令会先构建共享 contracts 与后端，然后同时启动 Vite 和 Nest，不需要提前手动 build。

- 前端 React/CSS 修改由 Vite 热更新。
- 后端或共享 contracts 修改后自动重新编译，成功后重启后端。编译失败时保留上一次服务，修正代码后自动重试。
- 后端重启会中断当前收听会话；需要重新开播。
- `Ctrl+C` 一起停止前后端。若端口已被旧服务占用，先在旧终端停止它，再执行命令。

根 `.env` 自动加载。后端默认 `127.0.0.1:8787`；设置 `HOST` / `PORT` 时，统一开发入口会同步调整 Vite 的 API 代理。修改 `.env` 后重新运行命令。DJ 语音需配置 `FISH_API_KEY`，音乐账号在 `/login` 扫码登录。

仅启动后端并监听修改：`npm run dev -w @radio/api`。

## 构建后运行

```sh
npm run build
npm start
```

此模式打开 http://127.0.0.1:8787 ，由 Nest 提供构建后的页面，不包含热更新。
