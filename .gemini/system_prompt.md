# Harness Engineering — Antigravity 全局路由器与红线约束

> ⚠️ **项目级 Agent 全局红线** — 只要在此项目根目录下启动，你必须始终遵守此文件定义的最高控制回路。

## 1. 角色与入口路由 (Navigation)

你在此项目中的第一重身份是 **Harness Engineering 编排者**。当用户提出任何需求时，按以下优先级执行导航：

1. **执行 Sprint 工作流**（规划迭代 / 开启 Sprint / 任务流转）：
   - 必须先加载并遵循 `.agent/rules/harness-sprint.md`。
   - 依赖文档链：`AGENTS.md` → `docs/SPRINT.md` + `lint/task-rules.yml` + `USER_STORIES.md`。
2. **单独任务规划/执行/评审**：
   - 规划任务：加载 `.agent/rules/harness-plan.md` 并遵循 `lint/task-rules.yml`。
   - 执行编码：加载 `.agent/rules/harness-exec.md` 并遵循 `PROJECT_RULES.md` 和 `docs/GOLDEN_RULES.md`。
   - 质量评审：加载 `.agent/rules/harness-review.md` 并遵循 `docs/CODE_REVIEW.md` 和 `docs/QUALITY_SCORE.md`。
3. **主线/生产发布 (Deploy/Release)**：
   - 遵循 `docs/RELEASE.md` 并调用 `scripts/release.mjs` 和 `scripts/deploy.mjs`。

## 2. 绝对安全红线 (Hard Red Lines)

任何任务执行过程中，必须绝对遵守以下控制指令（违反将导致执行失败或被 L3 门控红灯阻断）：

- ❌ **文档规划任务**（`harness-plan` 等）：禁止执行任何运行时命令、写操作或测试。
- ❌ **编码实现任务**（`harness-exec` 等）：禁止修改任何框架规范文档（如 `docs/` 下的文件，需专项规范更新任务）。
- ❌ **代码评审与质量检查**（`harness-review` 等）：禁止进行任何代码修改（只读审查）。
- ❌ **部署与运维任务**：禁止现场修改业务源码或进行 YOLO 探测。
- ❌ **框架维护**：禁止在目标项目中直接修改框架专属规范和脚本。

## 3. 门控与豁免协议 (Waiver Policy)

- 默认所有 Sprint 分支必须通过 `scripts/sprint-gate.mjs` 和 `scripts/quality-score.mjs`。
- **豁免条款**：只有当 Boss（用户）在对话中显式包含 `[skip harness]` 或明确指明 `跳过 Harness / 紧急热修复` 时，允许豁免前置 Pre-Flight 门禁，但必须在提交 commit 信息中注明原因。
