# MiniCode

本项目是一个本地优先的 Agentic Coding Assistant。

最新架构目标：

```text
Tool-Use Loop + Harness Runtime + Context Management + Markdown Memory
```

项目以接近 Claude Code 思路的本地编码 Agent 为目标：

- 模型通过工具调用循环推进任务
- Harness Runtime 统一执行工具、安全策略、审批和审计
- Context Manager 负责上下文投影、裁剪、压缩和 artifact 引用
- 代码检索优先使用 `Glob / Grep / Read`
- 文件修改优先使用 patch / diff 工作流
- 长期记忆以 Markdown 文件为主，向量库作为可选辅助
- 交互方式采用 CLI + Web UI，本地 daemon 运行

## 文档入口

- [AGENTS.md](./AGENTS.md)
- [文档导航](./docs/00_文档导航.md)
- [项目目标与架构设计](./docs/01_项目目标与架构设计.md)

## 当前状态

截至 2026-07-17，旧 `multi_agents / LangGraph` 原型到新 `minicode` 主线的架构迁移已经完成：

- `QueryLoop + HarnessRuntime` 成为唯一模型与工具执行主路径
- DeepSeek 使用 OpenAI-compatible 的结构化工具调用历史
- 工作区、策略、审批、分页读取、补丁写入和工具熔断已接入 Runtime
- 项目、会话和运行状态使用 SQLite 与项目本地 `.minicode/` 持久化
- 项目隔离的 Markdown Memory、上下文裁剪与敏感信息过滤已落地
- React + TypeScript + Vite 三栏工作台支持项目、会话、文件、工具结果和审批交互

完整产品化路线仍在继续，包括受控 SubAgent、持久化审计与评测、服务重启后的审批恢复等。后续设计以 `docs/01_项目目标与架构设计.md` 为准。

## 本地运行

后端在项目根目录启动：

```bash
conda run -n LLM python -m minicode.interfaces.web.server --host 127.0.0.1 --port 8080
```

前端在另一个终端启动：

```bash
npm --prefix web install
npm --prefix web run dev -- --host 127.0.0.1
```

Vite 默认地址为 `http://127.0.0.1:5173`，并将 `/api` 转发到本地 FastAPI 服务。

## 目标目录结构

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
