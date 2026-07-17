# AGENTS.md

本文件是仓库级入口文档，给新会话中的模型、协作者和未来的你一个最快速的项目总览。

## 1. 项目是什么

这是一个本地优先的 `Agentic Coding Assistant` 项目。

当前最新架构主线是：

```text
Tool-Use Loop + Harness Runtime + Context Management + Markdown Memory
```

项目以接近 Claude Code 思路的本地编码 Agent 为目标：模型通过工具调用循环推进任务，Harness Runtime 负责安全执行和审批，Context Manager 负责上下文投影与压缩，Memory 以 Markdown 文件为主进行长期沉淀。

产品目标：
- 帮助理解代码仓库
- 帮助制定开发计划
- 帮助修改代码、修 bug、做代码审查
- 帮助在受控环境中安全运行测试和工具

## 2. 当前阶段

当前处于：

**架构迁移完成，进入产品化完善阶段**

旧 `multi_agents / LangGraph` 主线已经移除，当前可运行实现统一位于 `src/minicode/`。QueryLoop、Harness Runtime、DeepSeek 工具协议、工作区安全、审批、上下文分页与裁剪、项目级 Markdown Memory、SQLite 项目/会话索引和 React 三栏工作台已经形成可用基线。

尚未完成的产品化能力主要是：受控 SubAgent、持久化 trace/audit/eval、服务重启后的审批恢复、完整 Diff/Plan/Artifact 前端和更系统的自动记忆治理。这些是迁移后的后续路线，不影响“旧架构已完成迁移”的结论。

新的设计目标是把系统收敛为：

- `QueryLoop`：模型驱动的工具调用主循环
- `Harness Runtime`：唯一安全执行入口
- `ToolSpec + RiskProfile`：工具能力与风险声明
- `WorkspaceManager`：工作区边界与路径治理
- `ContextManager + ArtifactStore`：上下文投影、大结果落盘、自动压缩
- `Markdown Memory`：项目规则、用户偏好、失败案例的文件化记忆
- `CLI + Web UI`：本地 daemon 上的双交互入口

## 3. 顶层技术决策

- 产品方向：`Local-first coding assistant`
- 核心循环：`Tool-Use Loop`
- 生命周期与中断：`QueryLoop + SQLite + Approval API`
- 执行控制：`Harness Runtime`
- 工具系统：`ToolSpec + RiskProfile + PolicyEngine`
- 代码检索：`Glob / Grep / Read`，优先使用 `ripgrep`
- 文件修改：`patch / diff` 工作流，弱化整文件覆盖
- 记忆系统：`Markdown Memory` 为主，`ChromaDB` 可选辅助
- 状态存储：`SQLite + 文件系统`
- 交互方式：`CLI + Web UI`
- 运行位置：用户本机 local daemon，默认只操作指定 workspace

## 4. 推荐阅读顺序

1. [架构入口](ARCHITECTURE.md)
2. [项目规则](PROJECT_RULES.md)
3. [用户故事](USER_STORIES.md)
4. [文档导航](docs/00_文档导航.md)
5. [项目目标与架构设计](docs/01_项目目标与架构设计.md)

## 5. 项目约束

- Agent 不直接越过 Runtime 执行副作用动作
- 所有文件修改、shell、git 写操作必须经过 Harness Runtime
- 优先使用专用工具，不默认使用 Bash
- 不把所有历史对话和工具输出直接塞进 prompt
- 大工具结果必须 artifact 化，prompt 只保留 preview 和引用
- 默认只读，受控写入，高风险审批
- 工作区外路径默认拒绝
- Markdown Memory 是长期记忆主路径，向量库只做辅助
- 新增文档与代码注释使用中文，标识符、命令和文件路径保留英文

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
  context/         # context projection + artifact + compact
  runtime/         # Harness + policy + workspace + approval
  tools/           # read/grep/edit/test/git/bash/task tools
  memory/          # Markdown memory + optional vector memory
  schemas/         # session/tool/event/memory/policy
  observability/   # trace/audit/eval
```

## 8. 当前状态

旧的 `multi_agents` LangGraph 原型及重复设计文档已删除。当前实现以 `src/minicode/` 为准，架构以 `docs/01_项目目标与架构设计.md` 为准，进度以 `docs/superpowers/plans/2026-07-15-minicode-productization.md` 顶部状态表为准。
