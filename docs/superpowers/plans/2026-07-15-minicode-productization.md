# MiniCode 产品化实施计划

> **状态（2026-08-19）：** 架构迁移和下一阶段可靠性建设均已完成。Run 与事件可在本地服务重启后恢复；审批认领具有原子性且最多执行一次；已经支持只读、受控的 SubAgent；只追加的可观测性与受治理的 Markdown 记忆也具备可执行基线。剩余工作主要是深化产品交互和发布加固。

## 进度快照

| 里程碑 | 状态 | 当前结果 |
|---|---|---|
| 1. DeepSeek 工具调用 | 已完成 | 已实现基于环境变量的模型工厂、OpenAI 兼容工具、原生 assistant/tool 历史、CLI 与本地服务接入，以及 provider 测试。 |
| 2. 项目/会话/Run 生命周期 | 可靠性基线已完成 | 已实现 SQLite Run 检查点和有序事件、重启恢复、SSE 重放、原子审批认领，以及保守的崩溃处理，保证副作用不会被自动重试。取消、重命名和归档仍属于交互增强项。 |
| 3. 上下文/Artifact/记忆 | 产品基线 | 已实现有界上下文、Artifact、敏感信息过滤、候选记忆、确定性去重、晋升、冲突替换、禁用/删除治理和 Web 记忆界面。富文本编辑与审计可视化仍待完善。 |
| 4. 受控 SubAgent | 只读基线已完成 | `task_agent` 提供隔离、受预算限制的 explorer/reviewer 运行时，带角色专属只读工具白名单和结构化结果。当前有意排除可写委派。 |
| 5. 三栏 Web 客户端 | 产品基线 | 已具备项目/会话恢复、文件查看器、工具时间线、持久化审批控制、Diff/Plan/输出/Memory 标签页和前端 API 回归测试。富 Artifact 渲染和响应式抽屉仍待完善。 |
| 6. 可观测性/评估 | 可执行基线 | 已实现 fsync 只追加 trace/audit 存储、递归敏感信息清理，以及可重复执行的 JSON 评估用例、报告和 CLI。仍需补齐发布场景覆盖。 |

**迁移门禁：** 已完成。**可靠性门禁：** 基线已完成。**产品化门禁：** 进行中。下列清单保留为详细验收标准和历史交付计划。

> **给执行本计划的 Agent：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项实施本计划。步骤使用复选框（`- [ ]`）记录进度。

**目标：** 将现有 MiniCode 运行时骨架建设为可用的本地编码助手，支持 DeepSeek 工具调用、持久化项目和会话，以及 Codex 风格的三栏 Web 工作台。

**架构：** 保持模型驱动的 `QueryLoop`，并以 `HarnessRuntime` 作为唯一执行路径。新增 DeepSeek provider 适配器、项目/会话/Run 生命周期应用服务，以及消费 FastAPI REST 与 SSE API 的 React 客户端。

**技术栈：** Python 3.11+、FastAPI、SQLite、OpenAI 兼容 Python SDK、DeepSeek API、React、TypeScript、Vite、SSE、pytest、Vitest。

## 全局约束

- API Key 只能从服务端环境变量读取，禁止持久化或通过浏览器暴露。
- 工作区文件写入、shell 命令、git 写操作和测试执行全部必须经过 `HarnessRuntime`。
- 所有路径必须受 `WorkspaceManager` 约束。
- `deepseek-v4-flash` 是默认工具调用模型；模型选择按项目配置且可调整。
- 项目级可移植运行产物存放在 `<workspace>/.minicode/`；全局项目/会话索引存放在用户的 MiniCode 主目录。
- 长期记忆严格按项目隔离。项目 A 的规则、偏好、摘要、Artifact 或检索结果都不得被项目 B 使用。
- 项目规则只有在完成隐私过滤、置信度校验、去重并写入审计事件后，才能被自动建议和持久化。UI 必须允许用户检查、编辑、禁用或删除每一条已存规则。
- Secret 和敏感值不得写入记忆、对话摘要、用于模型上下文的 Artifact、审计事件或浏览器响应。
- UI 只能调用 `minicode` API。
- 新增或更新的设计文档、实施计划、代码注释和用户可见提示默认使用中文；类名、API 字段、命令和第三方模型标识保留原始英文。

---

## 当时的基线状态

| 范围 | 状态 | 证据/缺口 |
|---|---|---|
| 工具调用循环 | 部分实现，可执行 | `QueryLoop` 每次执行一个模型请求的工具并发出事件，但当时只接入了脚本化演示模型。 |
| 文件与搜索工具 | 基线已实现 | `list_directory`、`glob_files`、`grep`、`read_file` 可在显式工作区内工作。 |
| 编辑与执行 | 基线已实现 | 已具备 Patch 建议/应用、测试、git 只读工具和兜底 bash；写入与 bash 需要策略审批。 |
| 安全策略 | 基线已实现 | 已阻止工作区逃逸；plan 模式只读；能发出审批决策，但当时还不能由服务/API 恢复。 |
| DeepSeek 模型 | 当时缺失 | 项目已有 OpenAI SDK 依赖，但当时只实现了 `JsonScriptModel`。 |
| 会话持久化 | 部分实现 | `SessionState` JSON 已保存到工作区 SQLite；当时尚无列表、追加消息、恢复、项目注册表或全局历史服务。 |
| 上下文压缩 | 原型 | 保留最近消息，并把更早消息截断为字符串；`TokenBudget` 当时未接入，也没有 LLM 摘要、优先级预算或持久化压缩检查点。 |
| Artifact 管理 | 基线已实现 | 大型工具输出可写入 `.minicode/runs/<run>/artifacts`；当时尚未向 UI/模型工具开放 Artifact 检索。 |
| Markdown 记忆 | 原型 | 已能创建 Markdown 文件和平面索引；当时没有规则加载器、路径匹配、记忆检索、自动提取或上下文注入。 |
| 多 Agent | 当时未实现 | 固定多 Agent 原型已删除；当时还没有 `task_agent` 工具或隔离的 SubAgent 运行时。 |
| Web 产品 | 当时缺失 | 新 FastAPI 本地服务只暴露 Run/状态/SSE JSON 端点。旧静态 UI 绑定旧运行时，不在迁移范围内。 |

## 目标用户体验

```text
左栏：项目与会话              中栏：对话与 Run 流程              右栏：工作区上下文
-----------------------      ---------------------------       ----------------------
打开本地项目                  任务输入和模式选择                  文件树
创建/重命名会话               Assistant 消息                     只读文件查看器
分组显示最近会话              可展开工具卡片                      Patch/Diff 预览
搜索会话历史                  审批提示与控制                      Plan、测试、Artifact 标签页
```

UI 可打开本地项目、创建或继续会话并启动 Run。SSE 在中栏渲染生命周期和工具事件。选择活动文件、Diff、测试结果或 Artifact 后，在右栏显示详情。破坏性操作会在中栏暂停，直到用户明确批准或拒绝。

## 已批准的记忆设计

### 范围与存储

每个项目拥有一个隔离的记忆根目录：

```text
<workspace>/.minicode/
  memory/
    MEMORY.md                 # 小型索引，以及启用/禁用规则元数据
    rules/                    # 持久项目约定和条件规则
    decisions/                # 明确的架构或工作流决策
    failures/                 # 可复用的故障诊断和恢复步骤
    summaries/                # 已完成会话的压缩检查点
    candidates/               # 等待置信度晋升的新推断规则
```

全局 MiniCode 数据库只允许保存重新打开项目所需的项目 ID、工作区路径和会话索引。不得保存项目记忆正文，也不得让一个项目的记忆被另一个项目检索。

### 记忆类别

| 类别 | 内容 | 持久化位置 | 检索方式 |
|---|---|---|---|
| 短期工作记忆 | 当前任务、当前计划、活动文件、最近消息、近期工具结果预览 | `SessionState` 和当前 Run | 在显式 token 预算内加入每次模型请求。 |
| 中期会话记忆 | 结构化压缩摘要、已完成决策、修改文件、测试结果、Artifact 引用 | 会话载荷；完成或压缩后写入 `memory/summaries/` | 只在重新打开该会话时加载；摘要位于最近轮次之前。 |
| 长期项目记忆 | 编码约定、命令、架构决策、路径特定规则、重复故障 | 项目 `memory/` 下的 Markdown 文件 | 先读 `MEMORY.md`；再根据任务、活动路径和元数据选择相关规则文件。 |

### 自动写入策略

只有当事实稳定且可复用时，Agent 才能写入候选记忆。例如：验证过的测试命令、用户明确指令、由仓库配置确认的项目约定，或带有验证后解决方案的重复故障。禁止保存临时任务细节、推测性结论、未经验证的模型假设、原始聊天文本或源代码副本。

写入流水线：

```text
工具结果/用户明确指令/验证过的结果
  -> 候选提取
  -> Secret 和敏感数据清理
  -> 证据与置信度检查
  -> 重复/矛盾检查
  -> 写入 Markdown 规则并更新 MEMORY.md 索引
  -> 持久化审计事件并发送 UI 事件
```

晋升规则：

- 用户直接指令或仓库声明的配置：立即晋升。
- 成功工具结果验证的事实：明确可复用且带证据时晋升。
- 模型推断的模式：先创建在 `candidates/`；只有在后续任务中被独立确认或用户明确操作后才晋升。
- 后续出现矛盾事实时，禁用旧规则并记录替代关系，不能静默覆盖历史。

### 隐私与敏感数据策略

在写入压缩摘要、Artifact 预览、审计记录、候选项或长期记忆之前，必须运行共享的 `SensitiveDataFilter`。至少应清理或拒绝 API Key、Bearer Token、密码、Cookie、私钥、连接字符串、URL 中嵌入的凭据、身份证件，以及任务不需要的电子邮箱和电话号码。

过滤必须发生在持久化之前和模型上下文构建之前。检测到的 Secret 应替换成简短且适合 UI 显示的提示，例如 `敏感值已清理`；原值不得复制到任何新存储位置。默认将 `.env`、凭据文件和已知 Secret 路径视为禁止写入记忆的来源。

### 检索规则

记忆不得整体附加到 prompt。每次模型步骤中，`MemoryService` 按以下顺序选择：

1. 加载项目的小型 `MEMORY.md` 索引。
2. 加入已启用的用户明确规则和项目全局规则。
3. 根据活动文件路径和任务关键词匹配条件规则。
4. 在记忆预算内，只加入最相关的故障/决策笔记。
5. 在 Run 审计轨迹中记录本次使用的记忆引用。

理解源代码仍采用 `Glob -> Grep -> Read`；长期记忆只补充仓库事实，不能替代直接验证。

## 交付顺序

### 里程碑 1：真实 DeepSeek 工具调用

**文件：**

- 新建：`src/minicode/engine/providers/__init__.py`
- 新建：`src/minicode/engine/providers/deepseek.py`
- 新建：`src/minicode/engine/model_factory.py`
- 修改：`src/minicode/engine/model_client.py`
- 修改：`src/minicode/interfaces/cli.py`
- 修改：`src/minicode/interfaces/web/server.py`
- 新建：`tests/test_deepseek_model.py`

- [ ] 编写失败测试：将 `ToolSpec` 转换为 OpenAI function schema、解析最终响应、解析工具调用响应，以及拒绝格式错误的 provider 响应。
- [ ] 实现 `DeepSeekModelClient(ModelClient)`：使用 `OpenAI(base_url=..., api_key=...)`，并携带可见工具调用 chat completions。
- [ ] 实现 `ModelFactory.from_environment()`：加载 `.env`，校验 `DEEPSEEK_API_KEY`、provider、模型和 base URL，并返回便于测试且不暴露 Key 的错误。
- [ ] 接入 CLI 和本地服务启动流程；保留 `--mock`，用于明确选择 `JsonScriptModel`。
- [ ] 在无网络条件下验证适配器测试，再运行完整 Python 测试套件。

**验收标准：** 完成配置后，`minicode -w <workspace> "read the README"` 使用 DeepSeek；模型工具调用始终由 `HarnessRuntime` 执行，provider 适配器不得直接执行。

### 里程碑 2：项目、会话和 Run 生命周期

**文件：**

- 新建：`src/minicode/application/project_service.py`
- 新建：`src/minicode/application/session_service.py`
- 新建：`src/minicode/application/approval_service.py`
- 新建：`src/minicode/storage/global_store.py`
- 修改：`src/minicode/storage/sqlite_store.py`
- 修改：`src/minicode/application/run_service.py`
- 修改：`src/minicode/interfaces/web/server.py`
- 新建：`tests/test_project_service.py`
- 新建：`tests/test_session_service.py`
- 新建：`tests/test_approval_service.py`

- [ ] 引入全局 `projects`、`sessions`、`runs` 和 `events` 表，包括项目根路径、时间戳、标题、模式、模型配置和状态索引。
- [ ] 增加项目 API：创建/打开、列表、更新显示元数据；选定路径成为项目工作区前，必须验证它是可读目录。
- [ ] 增加会话 API：创建、按项目列出、获取完整状态、重命名、追加用户消息和归档。保留会话消息与工具调用记录，不能每条 prompt 都新建会话。
- [ ] 增加 Run API：为会话启动 Run、流式传输持久化与实时事件、获取 Artifact、取消运行中 Run，以及用明确决策安全恢复因审批暂停的 Run。
- [ ] 内存队列只能作为实时传输优化；本地服务重启后，SQLite 是事实来源。
- [ ] 验证重启后可列出既有项目和会话、重新加载已完成会话，并确保批准后的暂停调用只恢复一次。

**验收标准：** 用户可关闭并重新打开本地服务，选择旧项目、查看其会话、打开其中一个并继续对话，且不丢失以前的任务状态。

### 里程碑 3：上下文、Artifact 和 Markdown 记忆

**文件：**

- 新建：`src/minicode/context/context_projector.py`
- 新建：`src/minicode/context/file_state_cache.py`
- 新建：`src/minicode/memory/rule_loader.py`
- 新建：`src/minicode/memory/memory_service.py`
- 新建：`src/minicode/memory/candidate_extractor.py`
- 新建：`src/minicode/memory/sensitive_data_filter.py`
- 新建：`src/minicode/memory/memory_audit.py`
- 修改：`src/minicode/context/context_manager.py`
- 修改：`src/minicode/context/compact_manager.py`
- 修改：`src/minicode/context/token_budget.py`
- 修改：`src/minicode/memory/markdown_memory.py`
- 修改：`src/minicode/engine/query_loop.py`
- 新建：`tests/test_context_manager.py`
- 新建：`tests/test_rule_loader.py`
- 新建：`tests/test_memory_service.py`
- 新建：`tests/test_sensitive_data_filter.py`
- 新建：`tests/test_candidate_extractor.py`

- [ ] 为 system、项目规则、任务、计划、活动文件、最近消息和近期工具结果定义显式上下文预算。
- [ ] 用确定性压缩检查点替代仅按字符截断：原样保留最近轮次，把更早轮次转换为结构化摘要，清理敏感值，并将摘要持久化到 `SessionState.compact_summary` 和项目本地会话摘要。
- [ ] 在每次持久化或上下文投影之前执行 `SensitiveDataFilter`。必须防止 Secret 和敏感值进入长期记忆、压缩摘要、审计载荷、Artifact 预览或 API 响应。
- [ ] 把 `MEMORY.md` 作为索引加载，并根据任务、文件路径 frontmatter 匹配和严格记忆预算选择性加载 Markdown 规则。不得在每次请求中注入全部记忆文件。
- [ ] 实现自动候选提取，包含证据、置信度、重复和矛盾检查。晋升明确指令和已验证事实；未验证推断保留为候选，直到独立确认。
- [ ] 在会话/Run 状态中记录 Artifact 元数据和记忆引用，并通过受限 API 和只读工具读取已清理的 Artifact。
- [ ] 增加 UI/API 操作，用于检查、编辑、禁用和删除项目记忆。所有记忆变更均需创建审计事件。
- [ ] 验证项目隔离、有界 prompt、路径匹配规则选择、Secret 清理、候选晋升、Artifact 引用和持久化压缩摘要。

**验收标准：** 长会话保持在配置的上下文预算内；旧细节可通过摘要/Artifact 追踪；只有相关规则进入模型请求；项目记忆不会跨项目泄露；敏感值不会被持久化，也不会进入 UI/事件流。

### 里程碑 4：作为工具的受控 SubAgent

**文件：**

- 新建：`src/minicode/engine/subagent.py`
- 新建：`src/minicode/tools/task_tools.py`
- 修改：`src/minicode/tools/base.py`
- 修改：`src/minicode/runtime/policy_engine.py`
- 修改：`src/minicode/engine/query_loop.py`
- 新建：`tests/test_task_agent.py`

- [ ] 将 `task_agent` 定义为普通 `ToolSpec`，而不是固定图节点。
- [ ] 首先支持只读 `explorer` 和 `reviewer` 模板；每个模板都具备工具子集白名单、最大轮次/工具预算和独立上下文。
- [ ] 只把结构化摘要、发现、活动文件和 Artifact 引用返回父会话；不得合并原始 SubAgent 消息。
- [ ] 将来任何 SubAgent 获得可写工具前，都必须经过明确策略审批。
- [ ] 验证 SubAgent 无法逃逸工作区、无法超过工具预算，也无法调用未在白名单中的工具。

**验收标准：** 主 Agent 可委派仓库探索或 Diff 审查，同时不会重新引入旧版固定 Master-Specialist 工作流。

### 里程碑 5：Codex 风格三栏 Web 客户端

**文件：**

- 新建：`web/package.json`
- 新建：`web/vite.config.ts`
- 新建：`web/src/main.tsx`
- 新建：`web/src/App.tsx`
- 新建：`web/src/api/client.ts`
- 新建：`web/src/state/project-store.ts`
- 新建：`web/src/components/ProjectSidebar.tsx`
- 新建：`web/src/components/SessionList.tsx`
- 新建：`web/src/components/ConversationPane.tsx`
- 新建：`web/src/components/RunTimeline.tsx`
- 新建：`web/src/components/ContextPane.tsx`
- 新建：`web/src/components/FileTree.tsx`
- 新建：`web/src/components/DiffViewer.tsx`
- 新建：`web/src/styles/app.css`
- 修改：`src/minicode/interfaces/web/server.py`
- 新建：`tests/web/*.test.tsx`

- [ ] 搭建独立 React + TypeScript + Vite 客户端；在本地服务模式下配置 FastAPI 提供生产构建产物。
- [ ] 实现左栏：项目切换、打开文件夹、新建会话、会话历史和归档控制。
- [ ] 实现中栏：持久消息时间线、模式选择、任务编辑器、SSE Run 时间线、可折叠工具结果，以及暂停操作的批准/拒绝控制。
- [ ] 实现右栏：文件树、语法高亮只读文件查看器、Diff、Plan、测试/输出和 Artifact 标签页。
- [ ] 实现响应式视口状态：窄屏保留对话栏，通过图标触发抽屉显示左右栏。
- [ ] 测试空、加载、失败、断连、等待审批和恢复会话状态；验证 API 响应不包含 Secret 配置。

**验收标准：** 用户可在单一 UI 中管理多个本地项目和独立对话，观察每个模型/工具动作，检查文件与 Diff，并批准受控写入。

### 里程碑 6：可观测性、评估和迁移收尾

**文件：**

- 新建：`src/minicode/observability/__init__.py`
- 新建：`src/minicode/observability/audit.py`
- 新建：`src/minicode/observability/trace.py`
- 新建：`src/minicode/evals/scenarios.py`
- 修改：`README.md`
- 修改：`AGENTS.md`
- 修改：`docs/01_项目目标与架构设计.md`
- 新建：`tests/test_audit.py`

- [ ] 持久化只追加 Run trace，包含模型元数据、工具请求、策略决策、审批、耗时和 Artifact 引用，但排除 prompt 中的 Secret。
- [ ] 增加确定性评估场景：仓库发现、只读规划、拒绝 plan 模式写入、批准 Patch、测试失败和上下文压缩。
- [ ] 发布迁移说明，记录旧原型移除和当前有效的 `minicode` 运行时。
- [ ] 运行完整 Python 与 Web 测试套件，并在一次性工作区完成 DeepSeek 端到端冒烟测试。

**验收标准：** Run 具备足够的可审计性和可复现性，可用于调试回归；团队拥有可度量依据来结束旧原型生命周期。

## 有意延后的事项

- 向量数据库和语义代码 RAG：只有在经过量化后确认 Markdown 记忆配合 `Glob -> Grep -> Read` 不足时才引入。该结论已被 2026-08-20 的混合记忆设计更新：向量检索只用于记忆辅助，不替代代码直接检索。
- 自主记忆写入：需要先具备检索评估和用户控制。
- 并行可写 SubAgent：在核心会话/运行时路径稳定前，协调和安全复杂度过高。
- 远程/多用户服务部署：在认证、租户隔离和 Secret 管理形成明确需求前，保持本地优先。

## 发布门禁

1. 里程碑 1 完成后，才能交互式使用新运行时。
2. 里程碑 2 完成后，才能构建会话历史 UI。
3. 里程碑 3 与 4 可在里程碑 2 后独立推进，但两者都完成后才能宣称具备生产级 Agent 行为。
4. 里程碑 5 依赖里程碑 2 的 API，并应使用里程碑 1 的稳定事件契约。
5. 里程碑 6 结束第一轮产品化周期，但不能据此过早删除仍需保留的兼容实现。
