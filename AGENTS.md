# AGENTS.md

本文件是仓库级入口文档，给新会话中的模型、协作者和未来的你一个最快速的项目总览。

## 1. 项目是什么

这是一个基于 `LangGraph + Harness` 思想构建的 `Agentic Coding Assistant` 项目。

产品目标：
- 帮助理解代码仓库
- 帮助制定开发计划
- 帮助修改代码、修 bug、做代码审查
- 帮助在受控环境中安全运行测试和工具

## 2. 当前阶段

当前处于：

**`Phase 5：工程增强（Trace / Eval / Audit）— ✅ 已完成`**

### 已完成

- ✅ LangGraph StateGraph 真实实现（11 节点，9 阶段状态机）
- ✅ AgentDecision 协议（所有 Agent 统一为 `AgentInput → AgentDecision`）
- ✅ 四种模式路由（Ask / Plan / Act / Review）
- ✅ 返工回路（Review → Implement, Test → Implement，上限控制）
- ✅ HITL 审批中断（LangGraph 原生 `interrupt` + `Command(resume=...)`）
- ✅ Harness Runtime 执行链路（Policy → Executor → Result）
- ✅ ToolExecutor 真实工具分发（read_file / write_file / search_code / run_shell）
- ✅ CLI 流式执行与中断恢复
- ✅ 大模型 API 接入（阿里云百炼 qwen3.6-plus，OpenAI 兼容接口）
- ✅ `.env` 配置管理（python-dotenv 自动加载）
- ✅ 测试体系（41 个单元测试与集成测试通过）
- ✅ Master-Specialist 架构改造
- ✅ ToolRegistry 按角色裁剪工具可见性
- ✅ ChromaDB 向量库记忆系统（4 Collection + 滑动窗口 + LLM 摘要）
- ✅ Web UI 交互界面（FastAPI + SSE + VS Code 风格前端）
- ✅ Shell 沙箱安全执行
- ✅ 审批流程图接线（高风险工具路由到 execute_tool_approval 节点）
- ✅ Plan 去重（apply_decision 跳过重复 plan）
- ✅ Trace 事件系统（5 类事件插桩 + Debug 面板时间线 Tab）
- ✅ Eval 评测框架（JSON 任务定义 + 评分器 + 运行器 + 报告）
- ✅ Audit 审计日志（write_file/run_shell 自动 JSONL 持久化）
- ✅ UI 增强（Markdown 渲染 + Agent 可视化 + 消息折叠）

### 待开始

- 暂无（Phase 0-5 已全部完成）

## 3. 顶层技术决策

### 智能体架构：Master-Specialist

```text
Master Agent（唯一决策中枢）
  │
  ├── Explorer Specialist（工具：read_file, search_code, list_directory）
  ├── Coder Specialist（工具：read_file, write_file, list_directory, run_shell）
  ├── Reviewer Specialist（工具：read_file, search_code）
  ├── Tester Specialist（工具：run_shell, read_file）
  └── Memory Writer Specialist（不调工具，只写记忆）
```

- 编排内核：`LangGraph`
- 协作范式：`Master-Specialist + HITL Approval`
- 执行控制：`Harness Runtime`
- 记忆系统：`ChromaDB 向量库 + 滑动窗口压缩`
- 产品方向：`coding assistant`
- 安全策略：`默认只读，受控写入，高风险审批`
- 交互方式：`Web UI（FastAPI + 原生前端）`

## 4. 推荐阅读顺序

1. [文档导航](docs/00_文档导航.md)
2. [项目目标与实施路线](docs/01_项目目标与实施路线.md)
3. [系统架构与模块设计](docs/02_系统架构与模块设计.md)
4. [智能体协作、状态流转与权限设计](docs/03_智能体协作_状态流转与权限设计.md)
5. [运行时与记忆系统设计](docs/04_运行时与记忆系统设计.md)
6. [项目结构与开发计划](docs/05_项目结构与开发计划.md)
7. [核心数据结构设计](docs/06_核心数据结构设计.md)
8. [项目完成度追踪](docs/07_项目完成度追踪.md)

## 5. 项目约束

- Master Agent 是唯一的决策中枢，Specialist Agent 不决策流程
- Agent 不直接越过 Runtime 执行高风险动作
- 每个 Agent 只有其专精工具的使用权限
- 不把所有历史对话和工具输出直接塞进 prompt
- 不在没有审批和策略控制时做高风险系统操作

## 6. 文档维护约定

- 每次关键沟通后，优先更新已有文档
- 文档命名采用中文，方便快速理解
- 尽量减少继续拆新文档

## 7. 核心代码目录

```text
src/multi_agents/
  agents/          # Master + Specialist Agent 实现
  interfaces/      # CLI + Web UI
  llm/             # LLM 客户端 + 角色提示词
  memory/          # 长短记忆 + 上下文管理
  observability/   # Trace 事件 + Audit 日志
  orchestrator/    # LangGraph 编排
  runtime/         # Harness + 策略 + 工具注册
  schemas/         # 核心数据结构
  tools/           # 原子工具定义

eval/              # 评测框架（Phase 5 新增）
  tasks/           #   评测任务 JSON
  runner.py        #   运行器
  scorer.py        #   评分器
```

## 8. 当前状态

所有 Phase 0-5 已全部完成。项目目前处于功能完备、待用户提出新需求或进入维护阶段的稳定状态。
