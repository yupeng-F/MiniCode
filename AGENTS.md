# AGENTS.md

本文件是仓库级入口文档，给新会话中的模型、协作者和未来的你一个最快速的项目总览。

## 1. 项目是什么

这是一个本地优先的 `Agentic Coding Assistant` 项目。

当前最新架构主线是：

```text
Tool-Use Loop + Harness Runtime + Budgeted Context + Hybrid Tiered Memory
```

项目以接近 Claude Code 思路的本地编码 Agent 为目标：模型通过工具调用循环推进任务，Harness Runtime 负责安全执行和审批，Context Manager 负责带硬上限的上下文投影与压缩，Memory 采用短期 Run 工作集、中期项目历史和长期 Markdown 规则，并以 SQLite FTS5 + ChromaDB 做混合检索。

产品目标：
- 帮助理解代码仓库
- 帮助制定开发计划
- 帮助修改代码、修 bug、做代码审查
- 帮助在受控环境中安全运行测试和工具

## 2. 当前阶段

当前处于：

**架构迁移完成，进入产品化完善阶段**

旧 `multi_agents / LangGraph` 主线已经移除，当前可运行实现统一位于 `src/minicode/`。QueryLoop、Harness Runtime、DeepSeek 工具协议、工作区安全、审批、上下文分页与裁剪、项目级 Markdown Memory、SQLite 项目/会话索引和 React 三栏工作台已经形成可用基线。

2026-08-20 已确认但尚未实现的下一阶段包括：长/中/短三级记忆、task 驱动的关键词与向量混合检索、TokenBudget 全链路硬上限、阿里云与本地 Embedding、Flash/Pro 模型切换、Enter 发送和对应的 Web 可观测性。这些是迁移后的产品化扩展，不影响“旧架构已完成迁移”的结论。

新的设计目标是把系统收敛为：

- `QueryLoop`：模型驱动的工具调用主循环
- `Harness Runtime`：唯一安全执行入口
- `ToolSpec + RiskProfile`：工具能力与风险声明
- `WorkspaceManager`：工作区边界与路径治理
- `ContextManager + TokenBudget + ArtifactStore`：48,000 token 输入硬上限、分区预算、大结果落盘和自动压缩
- `Tiered Memory`：短期 Run 工作集、中期项目历史、长期 Markdown 规则
- `HybridRetriever`：task + active_files 驱动的 SQLite FTS5、ChromaDB 与时间/路径混合排序
- `EmbeddingProvider`：阿里云 `qwen3.7-text-embedding` 为主，本地 FastEmbed/ONNX 为兜底
- `ModelCatalog`：默认 `deepseek-v4-flash`，Run 结束后可切换 `deepseek-v4-pro`
- `CLI + Web UI`：本地 daemon 上的双交互入口

## 3. 顶层技术决策

- 产品方向：`Local-first coding assistant`
- 核心循环：`Tool-Use Loop`
- 生命周期与中断：`QueryLoop + SQLite + Approval API`
- 执行控制：`Harness Runtime`
- 工具系统：`ToolSpec + RiskProfile + PolicyEngine`
- 代码检索：`Glob / Grep / Read`，优先使用 `ripgrep`
- 文件修改：`patch / diff` 工作流，弱化整文件覆盖
- 记忆系统：`Markdown + SQLite FTS5 + ChromaDB`，向量索引可删除重建
- 记忆隔离：项目历史不跨项目，只有明确用户偏好进入全局用户记忆
- 远程 Embedding：阿里云 `qwen3.7-text-embedding`（1024维）
- 本地 Embedding：FastEmbed `BAAI/bge-small-zh-v1.5`（512维）
- Prompt 预算：48,000 输入 tokens、8,000 输出 tokens、8,000 安全预留
- 消息上限：单条用户消息 12,000 tokens，超限拒绝且不得静默截断
- 模型选择：Flash 默认，Pro 可选，会话级默认、Run 级固化
- 状态存储：`SQLite + 文件系统`
- 交互方式：`CLI + Web UI`
- 运行位置：用户本机 local daemon，默认只操作指定 workspace

## 4. 推荐阅读顺序

1. [文档导航](docs/00_文档导航.md)
2. [项目目标与架构设计](docs/01_项目目标与架构设计.md)

## 5. 项目约束

- Agent 不直接越过 Runtime 执行副作用动作
- 所有文件修改、shell、git 写操作必须经过 Harness Runtime
- 优先使用专用工具，不默认使用 Bash
- 不把所有历史对话和工具输出直接塞进 prompt
- 大工具结果必须 artifact 化，prompt 只保留 preview 和引用
- TokenBudget 必须覆盖 System Prompt、工具 schema、原生工具历史和 reasoning_content
- 最新用户消息不得静默截断；长内容应保存为工作区文件后分页读取
- 默认只读，受控写入，高风险审批
- 工作区外路径默认拒绝
- Markdown Memory 是长期记忆唯一事实来源，FTS/向量索引只做可重建辅助
- 自动捕获只能产生 candidate，不得直接成为全局启用规则
- 远程 Embedding 前必须过滤敏感信息，并在 UI 明确提示外部传输和降级状态
- Key 只从 `.env` 或进程环境读取，不得进入数据库、日志、Trace、Audit 或前端
- Web Composer 使用 Enter 发送、Shift+Enter 换行，并正确处理中文输入法组合状态

## 6. 文档维护约定

- 每次关键沟通后，优先更新已有文档
- 文档命名采用中文，方便快速理解
- 尽量减少继续拆新文档

## 7. 目标代码目录

```text
src/minicode/
  interfaces/      # CLI + Web UI
  application/     # run/session/approval service
  engine/          # QueryLoop + prompt builder + model router
  context/         # token budget + projection + artifact + compact
  runtime/         # Harness + policy + workspace + approval
  tools/           # read/grep/edit/test/git/bash/task tools
  memory/          # tiered memory + FTS5 + Chroma + embedding providers
  schemas/         # session/tool/event/memory/policy
  observability/   # trace/audit/eval
```

## 8. 当前状态

旧的 `multi_agents` LangGraph 原型及重复设计文档已删除。当前实现以 `src/minicode/` 为准，架构以 `docs/01_项目目标与架构设计.md` 为准，进度以 `docs/superpowers/plans/2026-07-15-minicode-productization.md` 顶部状态表为准。

本轮 Memory/Context/Model 设计已经确认，但代码尚未实现。执行前必须先基于架构文档编写独立实施计划，按 TDD 分阶段落地，并避免把“设计目标”误报为“当前已实现”。
