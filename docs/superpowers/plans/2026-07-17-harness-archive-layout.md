# Harness 文件归档与路径重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将可安全归档的 Harness 通用文档和模板集中到明确目录，同时保持根目录兼容入口、命令和规则语义不变。

**Architecture:** Harness 运行入口继续使用根目录发现路径；通用文档移动到 `docs/harness/`，模板移动到 `.harness/framework/templates/`。新增根路径映射模块作为脚本和校验器的单一真相源，避免继续散落硬编码路径。MiniCode 源码、Web、测试和专属规范不移动。

**Tech Stack:** Node.js ES Modules、Node Test Runner、YAML、Git、pnpm、Python pytest。

## Global Constraints

- 不修改 `/Users/fish/Code/harness`。
- 不移动或改名 `src/`、`web/`、`tests/`、`pyproject.toml` 和 MiniCode 专属规范。
- 根入口 `.agent/`、`.gemini/`、`.github/`、`.gitlab/`、`lint/`、`config/`、`tools/`、根 `package.json` 保持可发现。
- 文档和新增代码注释使用中文；技术标识符、命令和路径保留英文。
- 迁移必须先有失败的路径/布局测试，再实现最小路径映射和移动。
- 所有迁移完成后必须运行 doctor、overlay 两次、五阶段门禁、规则校验和文档校验。

---

### Task 1：建立归档路径单一真相源和布局契约

**Files:**
- Create: `config/harness-paths.mjs`
- Create: `scripts/validate-harness-layout.mjs`
- Create: `tools/harness/archive-layout.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写失败的布局契约测试**

测试断言 `docs/harness/`、`.harness/framework/templates/` 存在，旧 `templates/` 不存在，并断言根入口仍存在。

- [ ] **Step 2: 运行测试确认 RED**

```bash
node --test tools/harness/archive-layout.test.mjs
```

预期：因新目录不存在而失败。

- [ ] **Step 3: 添加路径映射模块和测试脚本**

导出 `HARNESS_PATHS`，至少包含 `docs`、`templates`、`taskRules`、`scripts`，并提供 `node scripts/validate-harness-layout.mjs` 入口。

- [ ] **Step 4: 运行聚焦测试确认 GREEN**

```bash
node --test tools/harness/archive-layout.test.mjs
```

预期：布局契约通过。

- [ ] **Step 5: 提交**

```bash
git add config/harness-paths.mjs tools/harness/archive-layout.test.mjs package.json
git commit -m "test: define Harness archive layout contract"
```

### Task 2：归档通用文档并更新引用

**Files:**
- Move: `docs/CICD.md`, `docs/CODE_REVIEW.md`, `docs/CODING_BACKEND.md`, `docs/CODING_FRONTEND.md`, `docs/DESIGN.md`, `docs/GOLDEN_RULES.md`, `docs/MIGRATION.md`, `docs/OBSERVABILITY.md`, `docs/PRODUCT_ACCEPTANCE.md`, `docs/PRODUCT_SENSE.md`, `docs/QUALITY_SCORE.md`, `docs/RELEASE.md`, `docs/SECRETS.md`, `docs/SPRINT.md`, `docs/TECH_BACKEND.md`, `docs/TECH_FRONTEND.md`, `docs/TEST_CASES.md`, `docs/UI_DESIGN_SYSTEM.md` to `docs/harness/`
- Create: `docs/harness/README.md`
- Modify: `AGENTS.md`, `.agent/rules/*.md`, `.gemini/system_prompt.md`, `lint/*.yml`, `lint/harness-plugin.mjs`, `scripts/*.mjs`, `config/*.yml`

- [ ] **Step 1: 为旧路径引用增加失败扫描**

新增布局测试，扫描受影响配置和脚本不得继续引用被移动文档的旧根路径。

- [ ] **Step 2: 运行 RED**

```bash
node --test tools/harness/archive-layout.test.mjs
```

预期：发现旧 `docs/<name>.md` 引用。

- [ ] **Step 3: 移动文档并机械更新引用**

所有引用统一改为 `docs/harness/<name>.md`，README 说明这些是 Harness 通用文档，MiniCode 专属规范继续位于 `docs/MINICODE_*.md`。

- [ ] **Step 4: 运行布局、doctor 和文档校验**

```bash
node --test tools/harness/archive-layout.test.mjs
pnpm harness:doctor
node scripts/doc-lint.mjs
```

预期：布局和 doctor 通过；文档校验若暴露安装模板原有问题，记录精确文件后只修 MiniCode 路径问题。

- [ ] **Step 5: 提交**

```bash
git add AGENTS.md .agent .gemini config docs lint scripts tools
git commit -m "refactor: archive Harness documentation"
```

### Task 3：归档模板并修复运行时路径

**Files:**
- Move: `templates/` to `.harness/framework/templates/`
- Create: `.harness/framework/README.md`
- Modify: `config/harness-paths.mjs`, `scripts/release.mjs`, `scripts/observability-check.mjs`, `scripts/ui-tokens-lint.mjs`, `scripts/validate-task-rules.mjs`, `AGENTS.md`, `lint/task-rules.yml`

- [ ] **Step 1: 为模板根路径写失败测试**

测试从 `HARNESS_PATHS.templates` 读取 release、migration、observability 和 UI 模板，并断言旧 `templates/` 不存在。

- [ ] **Step 2: 运行 RED**

```bash
node --test tools/harness/archive-layout.test.mjs
```

预期：旧目录存在且映射路径不存在，测试失败。

- [ ] **Step 3: 移动模板并让脚本统一读取映射**

脚本只能通过 `config/harness-paths.mjs` 获取模板根路径，不新增第二套默认路径。

- [ ] **Step 4: 运行 GREEN 和行为门禁**

```bash
node --test tools/harness/archive-layout.test.mjs
pnpm harness:overlay
pnpm harness:doctor
node scripts/validate-task-rules.mjs
```

预期：通过，overlay 不修改模板目录且可重复执行。

- [ ] **Step 5: 提交**

```bash
git add .harness config scripts templates lint AGENTS.md tools
git commit -m "refactor: archive Harness templates"
```

### Task 4：全量验证、目录说明和收尾

**Files:**
- Modify: `.harness/project/README.md`, `docs/harness/README.md`, `AGENTS.md`
- Test: `tools/harness/archive-layout.test.mjs`

- [ ] **Step 1: 增加根目录分类说明和旧 worktree 说明**

明确 MiniCode 产品代码、项目约束、Harness 框架资产和根兼容入口的边界。

- [ ] **Step 2: 运行完整验证**

```bash
pnpm harness:doctor
pnpm harness:overlay
pnpm harness:overlay
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
node scripts/validate-task-rules.mjs
node scripts/doc-lint.mjs
git diff --check
```

- [ ] **Step 3: 检查 Harness 未修改**

```bash
git -C /Users/fish/Code/harness status --short
```

预期：不包含本任务产生的 tracked 或 untracked 变化。

- [ ] **Step 4: 提交**

```bash
git add .
git commit -m "refactor: organize Harness assets"
```
