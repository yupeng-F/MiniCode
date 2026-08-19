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

截至 **2026-08-19**，旧 `multi_agents / LangGraph` 原型到新 `minicode` 主线的架构迁移已经完成，项目进入产品化加固阶段：

- `QueryLoop + HarnessRuntime` 成为唯一模型与工具执行主路径
- DeepSeek 使用 OpenAI-compatible 的结构化工具调用历史
- 工作区、策略、审批、分页读取、补丁写入和工具熔断已接入 Runtime
- 项目、会话、完整 Run checkpoint 和有序 Event 流使用 SQLite 持久化
- daemon 重启后可恢复会话、事件和待审批调用；原子审批 claim 防止重复执行已批准的副作用
- SSE 使用持久化事件回放，浏览器刷新后可恢复最近的项目、会话和活动 Run
- 项目隔离的 Markdown Memory 支持候选、去重、晋升、冲突替换、禁用和删除
- `task_agent` 提供有独立上下文、工具白名单和轮次/工具预算的只读 explorer/reviewer SubAgent
- append-only Trace/Audit 在写入前执行敏感信息过滤；JSON Eval Runner 可生成可重复的机器可读报告
- React + TypeScript + Vite 三栏工作台支持项目、会话、文件、工具时间线、审批以及 Memory 管理

当前成熟度是 **产品化 Alpha / 可靠性基线**，不是稳定版。后续重点包括：

- 将 Run 生命周期进一步收敛到独立 Application Service，并补齐进程级故障注入场景
- 完整的 Diff、Plan、Test 和 Artifact 结构化资源及前端视图
- 可恢复 SSE 游标、取消、Session rename/archive 和更完整的运行状态机
- Trace/Audit 接入全部真实运行链路，并扩展内置 Eval 场景
- Memory 冲突处理 UI、SubAgent 子 Run 可观测性和发布级浏览器回归测试

架构边界以 [`docs/01_项目目标与架构设计.md`](./docs/01_项目目标与架构设计.md) 为准，实时里程碑和剩余验收项以 [`docs/superpowers/plans/2026-07-15-minicode-productization.md`](./docs/superpowers/plans/2026-07-15-minicode-productization.md) 顶部状态表为准。计划文件名中的 `2026-07-15` 是创建日期，不代表当前版本日期。

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
