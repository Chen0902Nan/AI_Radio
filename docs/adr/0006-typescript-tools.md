# ADR-0006：测试与工具使用 TypeScript

状态：已实施
日期：2026-09-18

## 原因

业务源码已使用 TypeScript，但测试、验证脚本和构建助手仍有 31 个 JS 文件，未进入类型检查。用户要求完成这部分迁移。

## 决定

ESM 使用 `.mts`，CommonJS 使用 `.cts`。项目固定 Node 24.16.0，直接运行可擦除类型的 TypeScript，无须 tsx/ts-node。保留原模块边界，尤其是加载 Nest 应用前设置隔离数据库路径、以及运行时测试加载 TSX 的顺序。

新增 `tsconfig.tools.json`，启用 `strict`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、`noEmit`，由 `npm run typecheck:tools` 执行，并纳入 `npm run typecheck`。Node 类型依赖在根包显式声明。

函数参数、开发进程、播放快照和资料检查报告具有类型声明。验证脚本接收的动态 HTTP 数据、证据对象及部分注入替身仍使用开放类型；严格检查通过不等于所有外部数据已经获得运行时校验。

## 运行命令

现有 npm 命令名称保持不变。直接调用文件时需改扩展名，例如：

```sh
node scripts/dev.mts
node scripts/read-library.mts
node scripts/verify-stability.mts --base=http://127.0.0.1:8792 --duration-min=120
npm run typecheck:tools
npm test
npm run test:browser
npm test -w @radio/web
npm test -w @radio/contracts
```

需要登录态或模型供应商的验证命令应使用隔离环境，其运行结果与离线测试分别记录。此次仅执行离线和浏览器替身回归，没有重新验收真实供应商链路。逐项结果与边界见 [迁移验证](../../.scratch/tooling-typescript/verification.md) 与 [任务记录](../../.scratch/tooling-typescript/issues/01-migrate-tools.md)。

## 兼容性

前后端与共享包的编译输出仍为 JS，`package.json` 的生产入口、`dist` 导入和 `.cjs` 播放控制器产物引用保留。历史验证报告里的旧命令记录保持原样；当前执行命令以各包 `package.json` 为准。

独立 contracts 测试命令改为先构建，再执行现有 `scripts/tests/program-contract.test.mts`，修复此前指向不存在目录的问题。

---

> 本文引用的 `.scratch/` 证据文件属本机工作区，未随仓库分发；克隆中这些链接不可用。
