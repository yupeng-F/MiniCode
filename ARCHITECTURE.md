# MiniCode 架构入口

## 1. 项目定位

MiniCode 是本地优先的 `Agentic Coding Assistant`。它以模型驱动的 `Tool-Use Loop` 推进任务，在用户指定的工作区内完成代码检索、计划、修改、测试和审查；副作用能力由产品内运行时统一约束。

本文只提供 Harness Agent 可快速加载的架构入口。详细产品架构、当前落地状态与后续路线以 [项目目标与架构设计](docs/01_项目目标与架构设计.md) 为准，避免在多个文件重复维护同一设计。

## 2. 技术栈

- 后端：Python 3.11、FastAPI、Pydantic。
- 状态存储：SQLite 与本地文件系统。
- 前端：React、TypeScript、Vite。
- 测试：pytest、Vitest；Playwright 用户旅程测试属于后续建设范围。

## 3. 七层职责

目标代码位于 `src/minicode/`，按七个职责层组织：

1. `interfaces/`：CLI 与 FastAPI Web 接口，只负责输入输出适配。
2. `application/`：运行、会话、项目与审批等用例编排。
3. `engine/`：`QueryLoop`、提示构建、模型协议与事件驱动。
4. `context/`：上下文投影、token 预算、压缩与 `ArtifactStore`。
5. `runtime/`：`HarnessRuntime`、`PolicyEngine`、`WorkspaceManager`、`ApprovalGate` 与工具执行。
6. `tools/`：Read、Glob、Grep、Patch、Test、Git 等具体工具能力。
7. `memory/` 与 `observability/`：长期记忆，以及后续 trace、audit、eval 能力。

## 4. 依赖方向

主要依赖方向是：

```text
interfaces -> application -> engine / runtime / context
                         engine -> runtime / context
                         runtime -> tools
```

- `interfaces` 不承载业务编排，也不直接执行工具。
- `engine` 决定下一步动作，但所有工具调用都交给 `runtime`。
- `tools` 只实现能力，不自行绕过 `HarnessRuntime`、`PolicyEngine`、`ApprovalGate` 或 `WorkspaceManager` 建立执行入口。
- `context` 负责把必要信息投影给模型；大结果通过 `ArtifactStore` 落盘后只传递预览和引用。
- `memory/observability` 是受上述层调用的支撑能力，不反向控制接口层。

## 5. 安全不变式

- 工作区边界：所有项目工具路径必须由 `WorkspaceManager` 解析并限制在指定 workspace 内；符号链接逃逸同样拒绝。
- 默认只读：没有明确策略许可时，不执行写入或其他副作用动作。
- 副作用审批：文件写入、Shell 与 Git 写操作必须经过 `PolicyEngine` 判断，并在策略要求时由 `ApprovalGate` 获得用户批准。
- 敏感路径：密钥、凭据及受保护目录不得被 Agent 工具读取或写入模型上下文。
- Artifact 落盘：超过上下文预算的工具完整结果写入工作区内的 Artifact，prompt 仅保留受控 preview 与 `artifact_ref`。

这些约束属于产品正确性的一部分，测试不得通过 Mock 绕过。

## 6. 两种 Harness 的边界

- **Harness Engineering** 是接入 MiniCode 的外部研发治理框架，负责通用任务规划、执行、评审与验证工作流。
- **MiniCode Harness Runtime** 是 MiniCode 产品内部的安全执行边界，对工具策略、工作区、审批和执行结果负责。

Harness Engineering 不替换 MiniCode Harness Runtime；MiniCode Harness Runtime 也不负责外部研发框架的 Sprint 或发布流程。两者名称相近，但所有权和运行阶段不同。
