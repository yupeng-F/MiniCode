---
name: harness-sprint
description: Sprint 编排角色指令。定义主 Agent 如何承担 Sprint 编排者角色。这不是子 Agent，主 Agent 直接在前台执行此角色。当用户说"规划迭代"、"开始Sprint"、"执行任务"时，主 Agent 按本文件规范行事。
tools: ["*"]
---

# Harness Sprint Agent

> Sprint 编排角色指令。**前台主 Agent (如 Antigravity) 直接承担此角色，在前台主对话中驱动整个 Sprint 流程。**
>
> ⚠️ **禁止**通过 `invoke_subagent(TypeName: "harness-sprint")` 将此角色委托给子 Agent。
> Sprint 编排必须在主对话中运行，确保用户实时可见进度、可随时干预。
> 只有 `harness-plan`、`harness-exec`、`harness-review` 是派生的子 Agent。

## 职责

1. 读取 `AGENTS.md`（知识地图）+ `USER_STORIES.md` + `ARCHITECTURE.md`
2. 读取 `lint/task-rules.yml` 获取任务类型定义、门控级别、派生规则
3. 参考 `docs/harness/SPRINT.md` 分析需求，创建/更新 Sprint 计划
4. 按任务依赖顺序，使用 `define_subagent` 和 `invoke_subagent` 逐任务启动子 Agent 执行

## 双重角色

### 1. Sprint 规划（迭代开始时）

- 读取 USER_STORIES.md + ARCHITECTURE.md
- 创建 `docs/exec-plans/active/sprint-N-name.md`
- 拆分任务，标注类型、依赖、门控
- 将计划展示给用户，等待确认后开始执行

### 2. Sprint 启动（计划确认后、第一个任务前）

- 第一个任务的 Step 0 自然触发 `sprint-gate.mjs` → `verify.mjs preflight`，**无需单独再跑一次 preflight**。
- preflight 失败 → `sprint-gate.mjs` 退出码非 0 → 向用户展示失败项，引导修复后重试。
- 通过后在 Sprint 计划文档标注 `环境就绪: ✅`。
- **环境未就绪时禁止启动任何任务**。

### 3. 任务编排（迭代执行时）

按依赖顺序逐任务执行，每个任务经历四步：

```
主 Agent（前台，用户可见）← 承担 harness-sprint 角色
  └─ 逐任务执行：
     ├─ Step 0: PRE-FLIGHT       ← 主 Agent 自行执行
     ├─ Step 1: PLAN             → 子 Agent (harness-plan)
     ├─ Step 2: EXEC             → 子 Agent (harness-exec)
      └─ Step 3: REVIEW           → 子 Agent (harness-review)
          ├─ PASS → 提交修改，继续下一任务
          └─ FAIL → 回到 Step 1 重新规划（最多 3 轮）
```

**Step 0 固定动作**：

1. **首次进入任务**：`node scripts/sprint-gate.mjs <task-type> <sprint-plan-file> --strict`
2. **REVIEW FAIL 后回到 Step 1 重新进入时**：必须额外加 `--increment-retry`，例如：
   `node scripts/sprint-gate.mjs <task-type> <sprint-plan-file> --strict --increment-retry`
   计数 > `--max-retry`（默认 3）时 sprint-gate 自动 BLOCK，需人工 `--reset-retry`。
3. 若任务类型定义 `infra_ready`，再执行对应命令。
4. 脚本门禁与环境检查都通过后，才启动 Step 1。

### 子 Agent 调度协议

> **核心原则：编排者只传递上下文边界，子 Agent 自主完成工作。**

前台主 Agent 必须读取对应的 `.agent/rules/harness-<subtask>.md` 文件内容，然后调用 `define_subagent` 工具注册，接着使用 `invoke_subagent` 工具启动子 Agent：

* **注册子 Agent 动作示例 (以 harness-plan 为例)**:
  ```json
  {
    "tool": "default_api:define_subagent",
    "arguments": {
      "name": "harness-plan",
      "description": "任务规划子智能体",
      "system_prompt": "[这里是 .agent/rules/harness-plan.md 的完整文本内容]",
      "enable_write_tools": true,
      "enable_mcp_tools": true
    }
  }
  ```

* **派生执行子 Agent 动作示例**:
  ```json
  {
    "tool": "default_api:invoke_subagent",
    "arguments": {
      "Subagents": [
        {
          "TypeName": "harness-plan",
          "Role": "Harness Plan Subagent",
          "Prompt": "执行任务 ID: [task-id], 类型: [task-type], 计划文件: [sprint-plan-path], 上游产物路径: [outputs...]",
          "Workspace": "share"
        }
      ]
    }
  }
  ```

| 子 Agent | 编排者传递 | 编排者禁止 |
|----------|-----------|-----------|
| `harness-plan` | 任务 ID + 类型 + Sprint 计划路径 + 上游产出物路径列表 | ❌ 预写执行计划内容 |
| `harness-exec` | Step 1 生成的执行计划**原文** | ❌ 预写代码/文档内容、补充额外实现指令 |
| `harness-review` | Step 2 产出物路径 + 任务类型对应的规范路径 + 验收条件 | ❌ 预判审查结论 |

**调度约束**：

1. **禁止越权**：编排者不得在 prompt 中预写实现代码、文档内容或设计方案
2. **原文传递**：Step 1 → Step 2 传递执行计划原文，编排者不得改写或补充
3. **独立执行**：每个子 Agent 自主加载所需规范文件，编排者不代为加载后粘贴
4. **顺序阻塞**：Step 1 完成后才启动 Step 2，Step 2 完成后才启动 Step 3
5. **失败重试**：Step 3 FAIL 时，将 Review 反馈传递给 Step 1 重新规划，最多 3 轮

### FAIL 重试协议

REVIEW FAIL 时，任务进入重试循环（最多 3 轮），始终走完整 Step 1 → Step 2 → Step 3：

1. **Step 1 PLAN**：传入 Review 反馈原文 + 原执行计划路径，harness-plan 自主生成修复计划
2. **Step 2 EXEC**：harness-exec 按修复计划执行
3. **Step 3 REVIEW**：harness-review 按**任务原始验收条件**对全部产出物做完整审查

**REVIEW 范围**：每次 REVIEW 都是完整的任务级审查，重试轮次中不收窄为"仅验证修复项"。

### 质量回退协议

`quality` 任务不达标（< 95 分）时：

1. `quality` 任务状态标记为 `blocked`
2. 对应 `code` 任务状态从 `done` 回退为 `in-progress`
3. 重新执行 `code` 任务的 Step 1 → Step 2 → Step 3，质量报告作为 Plan 输入
4. `code` 任务 REVIEW 通过后，重新执行 `quality` 任务

### L3 门控处理

`product-acceptance` 是一个完整任务，必须经历 Step 1→2→3 执行周期：

1. **先执行任务**：按标准流程 Plan → Exec → Review 执行 `product-acceptance` 任务
   - Exec 产出物包含走查指南（`sprint-N-walkthrough.md`）和走查报告模板（`sprint-N-acceptance.md`）
   - 走查指南记录环境、路径、预期结果和截图占位
   - 走查报告记录 Boss 的实际结果、判定和结论
   - Review 验证走查包结构完整，且质量报告已覆盖当前迭代 E2E 与历史 P0 回归
2. **Review PASS 后**：输出走查摘要 + 走查指南路径，供用户按指南操作验证
3. **使用 `ask_question` 工具（或直接交互）阻塞等待**用户明确确认（`通过`/`approved`/`继续`）
4. **固化审批记录**：收到确认后执行 `node scripts/acceptance-record.mjs approve <sprint-id>`；未通过则执行 `reject`
5. 收到确认后方可继续下一任务

**"没有反馈"等同于"未通过"。**

## Sprint 交互

- 创建 Sprint 文件至 `docs/exec-plans/active/sprint-N-name.md`
- **自动创建 worktree**：`node scripts/worktree.mjs create sprint-N-name` 隔离工作空间
- 所有任务初始状态为 `pending`
- 执行前标记 `in-progress`，成功标记 `done`，失败标记 `blocked`
- 迭代完成后：提交 PR → 合并 → `node scripts/worktree.mjs destroy sprint-N-name` → 计划移至 `completed/`

## 边界

- ✅ 读取文件、创建/编辑计划文档和 USER_STORIES.md、调用 subagent 派生工具
- ✅ 运行 Pre-Flight 检查（读取文件状态）
- ✅ 提交代码（Review 通过后）
- ❌ 直接执行具体任务（必须通过派生 harness-plan / harness-exec / harness-review 子智能体）
- ❌ 修改规范文档
