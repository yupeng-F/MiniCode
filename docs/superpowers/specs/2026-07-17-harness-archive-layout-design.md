# Harness 文件归档与路径重构设计

## 目标

在不改变 Harness 任务语义和 MiniCode 公开门禁命令的前提下，区分 MiniCode 产品文件、MiniCode 专属约束和 Harness 通用框架文件，降低根目录认知负担。

## 方案

采用“归档主体 + 根目录兼容入口”。通用框架资产归档到 `.harness/framework/`，MiniCode 专属适配说明归档到 `.harness/project/`；Harness 必须从仓库根目录发现的入口继续保留在根目录。

### 保留在根目录的兼容入口

- `.agent/`、`.gemini/`：Agent 启动规则和系统提示发现路径。
- `.github/`、`.gitlab/`：平台 CI 发现路径。
- `lint/task-rules.yml`、`lint/walkthrough-checks.yml`：Harness 规则发现路径。
- `config/`、`tools/harness/`、根 `package.json`：MiniCode 适配器和公开门禁入口。
- `AGENTS.md`、`PROJECT_RULES.md`、`ARCHITECTURE.md`：项目根级导航与核心约束。

### 归档到 `.harness/` 的主体

- `.harness/framework/`：通用模板、辅助脚本、通用测试资产和框架文档。
- `.harness/project/`：归档说明、MiniCode 适配说明、路径映射和维护指南。

涉及硬编码根路径的脚本不直接移动；先通过兼容入口或路径解析常量保持行为，再逐步归档可以安全归档的静态资产。任何迁移都必须保持 `pnpm harness:doctor`、`pnpm harness:overlay`、五阶段门禁和 `scripts/validate-task-rules.mjs` 行为不变。

## 安全边界

- 不修改 `/Users/fish/Code/harness`。
- 不删除或覆盖 MiniCode 产品源码。
- 迁移前后对所有文件执行 Git 差异和路径引用检查。
- 归档目录只包含已跟踪的 Harness 资产；协作临时目录和用户状态不纳入迁移。

## 验收

1. 根目录保留入口均可被 Harness 发现。
2. `.harness/framework/` 和 `.harness/project/` 有清晰 README 与路径映射。
3. `pnpm harness:doctor`、`pnpm harness:overlay` 通过且 overlay 幂等。
4. `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm test:e2e`、`node scripts/validate-task-rules.mjs`、`node scripts/doc-lint.mjs` 通过或记录明确的既有模板告警。
5. MiniCode 原有源码路径和业务行为不变。
