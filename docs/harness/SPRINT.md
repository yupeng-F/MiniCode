# Sprint 规范

> Sprint 生命周期、Agent 编排架构、任务流转和发布编排。
>
> **单一真源边界**：
> - `docs/harness/SPRINT.md`：Sprint / deploy-sprint 的流程与编排协议
> - `lint/task-rules.yml`：任务类型、工具边界、门控、产出物、验收条件、派生规则（机械执行真源）
> - `config/harness.yml`：项目级流程开关（走查环境、质量阈值、部署模式、UI L3）
> - `docs/harness/CICD.md`：CI/CD why-only 红线、分支/环境策略、故障速查；不定义 Sprint 流程

**核心原则：Sprint = PR 级别交付单元。** 每个 Sprint 聚焦单一可交付增量，粒度对齐一个 PR。

---

## Sprint 启动协议

Sprint 计划确认后，**第一个任务的 Step 0 自然触发环境验证**；编排者不单独再跑一遍 preflight。

### 启动检查

1. **执行 `node scripts/sprint-gate.mjs <task-type> <sprint-plan-file> --strict`**
2. `sprint-gate.mjs` 内部自动执行 `node scripts/verify.mjs preflight --skip-if-recent <ttl>`
3. 检查结果非 0 时：使用 `ask_user` 工具向用户展示失败项，引导用户修复后重试
4. 第一个任务 gate 通过后，在 Sprint 计划文档标注 `环境就绪: ✅`

### 环境恢复

当 preflight 检查失败时，编排者提供具体的修复指引：

| 失败项 | 修复指引模板 |
|--------|------------|
| Docker 服务未启动 | `docker compose up -d` 后等待 healthy |
| 环境变量缺失 | 列出缺失变量名 → 引导编辑 `.env` 文件 |
| 数据库表不足 | `pnpm db:push` 或 `pnpm db:migrate` |
| 外部服务不可达 | 列出不可达 URL → 引导检查网络/密钥/白名单 |

> **禁止在环境未就绪时继续执行任务。** Preflight 是 Sprint 的硬性前置条件。

---

## Agent 架构

Sprint 编排者由主 Agent 在前台承担；只通过 `task` 工具启动后三步子 Agent：

| agent_type | 步骤 | 角色 | 职责边界 |
|------------|------|------|---------|
| 主 Agent（前台） | Step 0 | Sprint 编排者 | 规划迭代、运行 Pre-Flight、调度子 Agent、管理任务状态；禁止委托给 `harness-sprint` 子 Agent |
| `harness-plan` | Step 1 | 规划者 | **自主**加载 task-rules.yml + 任务规范 → Readback → 生成执行计划；接收 Review 反馈重新规划 |
| `harness-exec` | Step 2 | 执行者 | **自主**接收执行计划，独立决定实现细节，产出任务交付物 |
| `harness-review` | Step 3 | 审查者 | **自主**对照规范验收条件审查产出物（PASS/FAIL）；只读不写 |

> **关键原则**：每个子 Agent 都是独立进程，有完整的自主权。编排者只传递上下文边界（见下方调度协议），不传递实现细节。

---

## 任务执行协议

每个任务经历四步，由 Sprint 主 Agent 编排，后三步各由独立子 Agent 执行：

```
主 Agent / Sprint 编排者（前台）
  └─ 逐任务执行：
     ├─ Step 0: PRE-FLIGHT       ← 主 Agent 自行执行
     ├─ Step 1: PLAN             → 启动子 Agent (agent_type: harness-plan)
     ├─ Step 2: EXEC             → 启动子 Agent (agent_type: harness-exec)
     └─ Step 3: REVIEW           → 启动子 Agent (agent_type: harness-review)
         ├─ PASS → 提交修改，继续下一任务
         └─ FAIL → 回到 Step 1 重新规划（最多 3 轮）
```

### Step 0: PRE-FLIGHT（编排者自行执行）

每个任务开始前按顺序执行：

1. **执行脚本门禁**：`node scripts/sprint-gate.mjs <task-type> <sprint-plan-file> --strict`
2. **基础设施就绪**：若任务类型定义了 `infra_ready` 命令，执行该命令；非 0 退出码时使用 `ask_user` 协调修复
3. **用户确认就绪**：需要人工操作的门控保持阻塞，直到收到明确确认

`sprint-gate.mjs` 负责校验依赖状态、上游产出物、质量报告、L3 审批记录和产出物结构。

### Step 1: PLAN → 启动子 Agent (agent_type: harness-plan)

子 Agent **自主完成**以下工作（编排者不代劳）：

1. 从 `lint/task-rules.yml` 获取任务类型对应的规范路径，**加载规范原文**
2. 加载上游产出物（PRD/设计/技术方案）作为上下文
3. 执行 Readback（输出执行步骤和评分标准原文摘录），Readback 与规范不一致则禁止继续
4. 生成详细执行计划（修改哪些文件、实现方式、验收标准）

### Step 2: EXEC → 启动子 Agent (agent_type: harness-exec)

子 Agent 接收 Step 1 的执行计划全文，**自主决定实现细节**，按计划执行，只用任务类型允许的工具。

### Step 3: REVIEW → 启动子 Agent (agent_type: harness-review)

子 Agent **自主**接收产出物 + 规范验收条件，逐项审查：
- **PASS** → 主 Agent 提交修改，更新任务状态为 `done`，继续下一任务
- **FAIL** → 生成具体问题 + 修复建议 → 回到 Step 1 由 harness-plan 重新规划

**REVIEW 范围**：每次 REVIEW 都按任务原始验收条件对全部产出物做完整审查。重试轮次中，REVIEW 范围不收窄为"仅验证修复项"。

### 产出物模板约束

当规范定义了评分体系（如 `QUALITY_SCORE.md`）时，报告维度和权重 **必须与规范一致**，Agent 只填写实际得分和证据，禁止自定义维度或修改权重。

---

## 子 Agent 调度协议

> **核心原则：编排者只传递上下文边界，子 Agent 自主完成工作。**

编排者通过 `task` 工具启动子 Agent，每个子 Agent 是独立进程，拥有完整工具集和自主决策权。

### 编排者传递内容（输入边界）

| 子 Agent | 编排者传递 | 编排者禁止 |
|----------|-----------|-----------|
| harness-plan | 任务 ID + 类型 + Sprint 计划路径 + 上游产出物路径列表 | ❌ 预写执行计划内容 |
| harness-exec | Step 1 生成的执行计划**原文** | ❌ 预写代码/文档内容、补充额外实现指令 |
| harness-review | Step 2 产出物路径 + 任务类型对应的规范路径 + 验收条件 | ❌ 预判审查结论 |

### 调度约束

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

**REVIEW 范围不收窄**：重试轮次的 REVIEW 始终对全部产出物做完整审查，确保修复未引入新问题。

### 质量回退协议

`quality` 任务不达标（< 95 分）时：

1. `quality` 任务状态标记为 `blocked`
2. 对应 `code` 任务状态从 `done` 回退为 `in-progress`
3. 重新执行 `code` 任务的 Step 1 → Step 2 → Step 3，质量报告作为 Plan 输入
4. `code` 任务 REVIEW 通过后，重新执行 `quality` 任务

---

## 迭代生命周期

**状态**：`planning` → `active` → `completed`

**流程**：读取 USER_STORIES.md → 创建 `exec-plans/active/sprint-N-name.md` → 按依赖逐任务执行 → 完成校验通过 → 移至 `completed/`

**任务状态**：`pending` | `in-progress` | `done` | `blocked` | `spawned`

**Sprint 闭环协议**（L3 走查通过后，编排者依序执行）：

1. 走查问题记录至 `docs/exec-plans/tech-debt-tracker.md`（若有偏差）
2. 合并 PR（sprint 分支 → develop）— 属于 `pr` 任务
3. 销毁 worktree：`node scripts/worktree.mjs destroy sprint-N-name`
4. 归档计划：`exec-plans/active/sprint-N-*.md` → `exec-plans/completed/`
5. 更新 `AGENTS.md` 当前迭代指针
6. 更新 `USER_STORIES.md` 中已交付 Story 状态

> 步骤 1-2 由 `pr` 任务负责（L3 通过后合入）；步骤 3-6 由 `sprint-close` 任务负责（环境清理与归档）。

**迭代完成校验**（闭环前逐项确认）：
1. 全部任务状态为 `done`（无 `pending`/`blocked`/`in-progress`）
2. L3 门控任务已获用户通过 `ask_user` 工具明确确认（`通过`/`approved`），且已生成 `sprint-N-boss-signoff.yml`
3. 全量检查通过（`pnpm typecheck && pnpm lint && pnpm test && pnpm build`）+ 质量评分 ≥ 95 + 产品走查通过
4. 产出物文件**物理存在**：`docs/acceptance-reports/sprint-N-acceptance.md` + `sprint-N-walkthrough.md` + `sprint-N-boss-signoff.yml`

### 手动 PR 工作流

当 Git 托管平台无 CLI API（如 GitLab 无 `glab`）时，`pr` 任务仍必须通过 `scripts/pr-adapter.mjs create` 执行；GitLab push-options fallback 只允许封装在 adapter 内部，禁止 Agent 在任务中直接拼接 MR 命令。

1. **Agent 执行全量检查**：`pnpm typecheck && pnpm lint && pnpm test && pnpm build` 作为 CI 替代
2. **Agent 调用 adapter**：`node scripts/pr-adapter.mjs create --base <target> --head <source> --title <title> [--body-file <file>]`
3. **adapter 创建 MR 或输出阻塞原因**：有 `glab` 时走 GitLab API；无 `glab` 时由 adapter 内部使用 GitLab push-options 创建 MR
4. PR/MR 合并由用户手动操作，Agent 使用 `ask_user` 确认合并完成

---

## Sprint 阶段与任务流

> 任务类型明细、门控、工具、产出物、验收条件与派生规则只在 `lint/task-rules.yml` 定义；本文只说明编排者如何选择流程。

### Feature Sprint

Feature Sprint 是 PR 级交付单元，默认创建 worktree。含 `code` 的 Sprint 必须包含 `product-acceptance`、`pr`、`sprint-close`。

| `config/harness.yml.walkthrough_env` | 任务流 |
|---|---|
| `development` | `product/design/tech` → `code` → `test-case-gen` → `quality` → `product-acceptance(L3)` → `pr` → `sprint-close` |
| `test` | `product/design/tech` → `code` → `test-case-gen` → `promote-prep(test)` → `build-image` → `promote-test` → `quality` → `product-acceptance(L3)` → `pr(develop + test)` → `sprint-close` |

`test` 模式表示质量评分和产品走查必须基于 Test 环境；因此 Test 部署任务必须在 `quality` 前通过。Boss 走查通过后，`pr` 任务必须同时完成两条 MR：Sprint 分支 → `develop`，已走查提交 → `test`。`sprint-close` 在 `walkthrough_env=test` 时由 `sprint-gate.mjs` 强制校验 Boss signoff 中的 `commit_sha` 已同时抵达 `origin/develop` 与 `origin/test`；未抵达时禁止关闭。`development` 模式若另行要求测试发布，不插入 feature-sprint 主链，改为 Sprint 关闭后启动独立 deploy-sprint。

### Deploy Sprint

Deploy Sprint 只处理发布任务，不创建 worktree，不承载产品/代码设计任务。

| 目标 | 任务流 |
|---|---|
| test | `promote-prep(test)` → `build-image` → `promote-test` → `integration` |
| prod | test 链路通过后 → `release-prep` → `migration-design` + `regression` → `release-approval(L3)` → `prod-deploy` → `back-merge` → `observe` |

### Hotfix

Hotfix 是线上事故专项 Sprint，允许创建 hotfix worktree，但仍复用任务类型和 Step 0→3 协议；生产合并与回灌走 `prod-deploy` / `back-merge` 任务，不恢复旧 `harness-release` Agent。

### task-rules.yml 字段边界

| 字段 | 含义 | 执行时机 |
|------|------|---------|
| `entry_command` | 任务唯一入口脚本 | Step 2 EXEC |
| `infra_ready` | 任务级基础设施检查命令 | Step 0 PRE-FLIGHT |
| `prerequisites` | 必须全部满足的前置条件 | Step 0 PRE-FLIGHT |
| `prerequisites_any` | 每组满足任意一个即可的前置条件（如 inline test 部署或独立 deploy-sprint） | Step 0 PRE-FLIGHT |
| `manual_steps` | 需用户手工完成的步骤 | Step 2 EXEC |

---

## Sprint 计划文档

文件路径：`exec-plans/active/sprint-N-name.md`

**头部字段**：目标（一句话）、状态、验收标准、依赖、关联 User Story

**任务表列**：`| ID | 类型 | 任务描述 | 依赖 | 产出物 | 验收条件 | 状态 |`

**规则**：含 `code` 须包含 Phase 5-11（含 `product-acceptance` L3 走查）、任务依赖列含上游产出物路径、前端 `code` 依赖对应后端 `code`

---

## 任务派生与前置条件

`lint/task-rules.yml.spawn_rules` 是任务派生真源；`scripts/sprint-gate.mjs` 在 Step 0 根据 `prerequisites`、`prerequisites_any`、`readiness`、`approval_artifact` 和 `.harness/state/*` 执行硬校验。

编排者不得在 SPRINT.md 手写第二套派生链；需要变更流程时，优先修改 `task-rules.yml`，再只在本节补充流程解释。

---

## ⛔ L3 门控

`product-acceptance` 是 L3 门控任务，**必须先完整执行（Step 1→2→3），再呈现门控。**

### 执行流程

1. **执行任务**：`product-acceptance` 按标准 Plan → Exec → Review 流程执行
   - Exec 产出 **走查指南**（`sprint-N-walkthrough.md`）和 **走查报告模板**（`sprint-N-acceptance.md`）
   - 走查指南记录环境、路径、预期结果和截图占位
   - 走查报告记录 Boss 的实际结果、判定和结论
   - Review 验证走查包完整、结构正确、质量报告已覆盖当前迭代 E2E 与历史 P0 回归
2. **Review PASS 后**：输出走查摘要 + 走查指南路径，供 Boss 按指南操作
3. **使用 `ask_user` 工具阻塞等待**用户明确确认（`通过`/`approved`/`继续`）
4. **固化审批记录**：收到确认后执行 `node scripts/acceptance-record.mjs approve <sprint-id>`；未通过则执行 `reject`
5. Boss 确认后方可继续 `pr`，PR 合并后再进入 `sprint-close`

| 门控 | 触发时机 | 必要产出物 | 阻塞方式 |
|------|---------|-----------|---------|
| 产品走查 | `product-acceptance` Review PASS 后 | `sprint-N-walkthrough.md` + `sprint-N-acceptance.md` + `sprint-N-boss-signoff.yml` | `ask_user` 工具 |

### L3 执行约束

- 走查指南先于 Boss 走查生成，走查报告用于记录 Boss 结果
- `ask_user` 是 L3 的唯一放行动作
- `sprint-close` 以前，`sprint-gate.mjs` 必须校验签收文件和走查产物结构

**"没有反馈"等同于"未通过"。**

---

## 任务执行约束

1. **文档先行**：代码须有技术方案，禁止无方案编码
2. **质量门禁**：代码须通过质量评分后才能发布
3. **迭代增强优先**：Sprint N+1 在已交付模块上增强，禁止创建平行功能
4. **浏览器 E2E 不可替代**：前端须 `webapp-testing` 或 `chrome-devtools` 验证
5. **产出物模板约束**：规范定义的维度和权重不可修改

### 渐进式加载上下文

所有 Agent 必须先通过 `AGENTS.md` 导航与目录 `index.md` 检索候选文档，再按任务类型逐步加载正文，禁止一次性读取整个 `docs/` 知识库。

| 任务类型 | 历史文档使用规则 |
|---|---|
| PRD / 设计 / 技术方案 | 先读本次 User Story 与对应索引；只加载与当前需求强相关的历史文档。产出物是新的迭代文档，必须显式写清对旧设计的变更、优化、删除；不直接改旧 PRD/设计/技术方案。 |
| 多份相关历史文档 | 优先选择最近更新、验证状态为 `verified` 的文档；若逻辑冲突，以更新且更贴近当前需求的文档为参考，并在新文档记录取舍。 |
| Coding | 只读取本次迭代 PRD/设计/技术方案与项目编码规范；不得回读历史 PRD/设计/技术方案作为实现依据。历史变化必须已经沉淀在本次迭代文档中。 |
| 测试用例 | 与 Code 一样描述系统最新状态。生成前检索 `test-cases/index.md` 与相关 YAML；业务流程变更时直接修改既有用例并更新 `last_modified_in` / `last_verified_in`，不得基于旧流程平行新增重复用例。 |

### 子任务拆分

**触发**（任一）：≥ 3 独立模块 | 验收条件 ≥ 5 | 产出 ≥ 500 行代码 | 同时涉及前后端

**规则**：单一职责、独立验收、依赖显式。编号：父 ID + 字母（T-14a, T-14b）。

---

## CI/CD 与发布编排

> 发布任务已经并入 Sprint 编排。`docs/harness/CICD.md` 只解释 CI/CD 红线和策略，不再定义独立流程。

### Sprint 类型（H-OPT v1.6）

| 类型 | 触发 | 任务集 | worktree | 备注 |
|------|------|--------|---------|------|
| feature-sprint | 默认 | infra→…→code→test-case-gen→quality→product-acceptance→pr→sprint-close | 是 | `walkthrough_env=test` 时在 quality 前插入 promote-prep/build-image/promote-test |
| deploy-sprint(test) | 项目要求测试发布 | promote-prep→build-image→promote-test→integration | 否 | 不开新分支，操作 `release-staging/<train>` |
| deploy-sprint(prod) | 项目要求生产发布 | …→release-prep→migration-design+regression→release-approval(L3)→prod-deploy→back-merge→observe | 否 | 含强制 L3 |
| hotfix | 线上故障 | hotfix-init→code→quality→prod-deploy→back-merge | 是 | 跳过 deploy-sprint 编排 |

### 编排者职责（取代独立 release Agent）

1. **判定 Sprint 类型**：根据用户指令 + `config/harness.yml.walkthrough_env` 决定流程
2. **deploy-sprint 启动**：feature-sprint sprint-close 通过后，按需启动 deploy-sprint（与 feature 互斥串行）
3. **配置门禁**：promote-prep 必须先通过；`.harness/state/promote-prep-<env>.json ready=true` 才能 build-image

### 关键状态文件

```
.harness/state/
├── promote-prep-<env>.json   # 部署配置就绪标记
├── build-image-<sprint>.json # 镜像 tag + 构建结果
├── promote-<env>-<sprint>.json # promote 执行日志
└── env-locks/<env>.lock      # 环境互斥锁
```
