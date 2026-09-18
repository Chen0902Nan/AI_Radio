# 测试和工具 TypeScript 迁移

将原有 31 个受 Git 管理的 JS 测试、验证工具和构建助手迁移为 TypeScript。

- 原 ESM `.mjs` 改 `.mts`，原 CommonJS `.cjs` 改 `.cts`，保留模块加载顺序。
- 使用项目锁定的 Node 24.16.0 直接运行，不引入额外 TS 执行器。
- 更新 npm 根包、API、Web 和 contracts 的对应命令与源码内导入路径。
- 独立 `tsconfig.tools.json` 开启 strict、verbatimModuleSyntax、erasableSyntaxOnly；纳入根 typecheck。
- 测试行为、实际断言和验证工具的外部调用职责保持不变；类型修正允许更新已失效的 Puppeteer 参数。
- 构建产物继续是 JS，不提交编译目录，不用 GitHub 统计覆盖规则隐藏代码。

验收：31 个迁移文件均能由 Node 原生擦除类型并解析；全套离线测试、浏览器回归、独立工作区测试与类型检查通过。
