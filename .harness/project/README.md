# MiniCode Harness 项目适配

MiniCode 的专属适配入口包括：

- `config/minicode-harness.yml`：命令和任务覆盖单一真相源。
- `config/harness-paths.mjs`：归档资产路径映射。
- `tools/harness/`：配置加载、命令执行、overlay 和 doctor。
- `PROJECT_RULES.md`、`ARCHITECTURE.md` 与 `docs/MINICODE_*.md`：项目事实和约束。

通用 Harness 源码位于 `/Users/fish/Code/harness`，只读使用，不在 MiniCode 中修改。
