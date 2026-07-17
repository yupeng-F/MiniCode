# MiniCode 用户故事

本文件登记可由 Harness Feature Sprint 交付的 MiniCode 产品故事。每个故事的 `ready` 表示范围与验收标准已经可执行，不表示功能已经完成；实际落地状态仍以代码、测试和产品化计划为准。

## 状态定义

- `ready`：可以进入一个 Feature Sprint，尚未声明交付完成。
- `in_progress`：正在实施并保留红—绿测试证据。
- `done`：全部自动化验收标准和仓库门禁通过。

## US-001：可靠的 Glob/Grep/Read 仓库检索

- 状态：`ready`
- 目标：作为用户，我希望 Agent 可靠地发现和读取工作区代码，以便无需预构建向量索引也能理解仓库。
- Sprint 边界：只完善 Glob、Grep、Read 的结果正确性、安全边界和测试，不同时改造 Patch 或 UI。

自动化验收标准：

1. pytest 在临时 workspace 创建嵌套文件后，验证 Glob 只返回匹配的工作区相对路径，结果顺序稳定且不包含敏感目录。
2. pytest 验证 Grep 返回包含 `path`、`line` 与 preview 的匹配结果，遵守结果上限，并对无匹配返回可区分的空结果而非异常。
3. pytest 验证 Read 的 `offset`、`limit`、`total_lines` 与 `next_offset` 能无重叠地分页还原文件。
4. pytest 验证三种工具都拒绝工作区外路径、符号链接逃逸和敏感目录，且判断来自真实 `WorkspaceManager`。

## US-002：可预览、审批和应用的 Patch 工作流

- 状态：`ready`
- 目标：作为用户，我希望先看到 Patch 的准确 diff，再决定是否应用，以便控制文件修改风险。
- Sprint 边界：交付单工作区 Patch 的预览、批准、拒绝和应用，不扩展通用编辑器或远端 Git 流程。

自动化验收标准：

1. pytest 验证 `propose_patch` 返回目标文件 diff，预览阶段文件内容和哈希保持不变。
2. pytest 验证未审批的 `apply_patch` 停在 `waiting_approval`，`PolicyEngine` 和 `ApprovalGate` 的真实状态均可观察。
3. pytest 验证批准后 Patch 恰好应用一次，结果列出修改路径，重复批准不会重复修改。
4. pytest 验证拒绝与无效 Patch 均不改变文件，并返回可测试的拒绝或失败原因。

## US-003：SQLite 持久化的审批暂停与恢复

- 状态：`ready`
- 目标：作为用户，我希望等待审批的运行在 daemon 重启后仍可恢复，以便不会丢失任务或重复执行副作用。
- Sprint 边界：只覆盖单 session 的持久化恢复、审批幂等和并发冲突，不引入分布式队列。

自动化验收标准：

1. pytest 使用临时 SQLite 验证 QueryLoop 暂停时原子保存 `waiting_approval`、待执行工具调用和恢复所需上下文。
2. pytest 销毁并重建应用服务后，通过 Approval API 批准同一 run，验证从持久化恢复点继续并只执行一次副作用。
3. pytest 验证拒绝后被拒工具不执行，重启后仍能读取终态与审批决定。
4. pytest 并发提交两个决定时验证仅一个成功，另一个返回 `409`，且数据库和文件结果一致。

## US-004：Web UI 展示工具调用、结果和审批状态

- 状态：`ready`
- 目标：作为用户，我希望在 Web UI 中看清 Agent 正在调用什么工具、得到什么结果以及何时需要审批，以便透明地控制运行。
- Sprint 边界：完善现有工作台的工具与审批主路径，不同时建设完整 Trace、Memory 或 Artifact 管理器。

自动化验收标准：

1. Vitest 验证工具调用按运行顺序呈现 `running`、`waiting_approval`、`completed` 与 `failed` 状态，并展示结果摘要或错误信息。
2. Vitest 验证等待审批时展示工具名、影响内容、批准和拒绝按钮；重复点击被禁用且只发出一次 API 请求。
3. Vitest 验证批准、拒绝和后端错误后界面刷新到对应状态，并呈现加载、空与可重试错误反馈。
4. Vitest 使用 fake timer 验证 session 切换、终态或组件卸载后清理轮询，不再产生过期请求或覆盖当前 session。

## US-005：上下文压缩和 Artifact 引用

- 状态：`ready`
- 目标：作为用户，我希望长工具结果在不撑爆模型上下文的情况下仍可追溯，以便大型仓库任务保持连续性。
- Sprint 边界：完善单次运行的预算触发、压缩和 Artifact 引用，不扩展跨项目向量记忆。

自动化验收标准：

1. pytest 用确定性长工具结果验证超过预算时完整内容写入当前 run 的 Artifact，返回稳定且可读取的 `artifact_ref`。
2. pytest 验证发送给模型的上下文只包含受限 preview、摘要和引用，不重复包含 Artifact 完整正文。
3. pytest 验证旧消息压缩后保留活动任务、最近消息、待审批调用和活动文件，QueryLoop 仍能继续下一步。
4. pytest 验证 preview、压缩摘要和 Artifact 写入前均应用敏感信息过滤，默认测试不调用真实模型。

## 统一完成条件

故事只有在对应自动化验收标准全部通过，并完成以下仓库门禁后才能从 `ready` 或 `in_progress` 改为 `done`：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
