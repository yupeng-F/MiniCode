# MiniCode 项目规则

本文件定义 MiniCode 开发必须遵守的仓库级规则。详细架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，专项约束见 `docs/MINICODE_*.md`。

## 1. 语言与变更范围

- 新增文档与代码注释使用中文；标识符、命令和文件路径保留英文。
- 只修改当前任务所需文件，不顺带重构无关模块。
- 不把目标架构或 `ready` 用户故事描述成已经落地的能力。

## 2. Python 与外部输入

- Python 公共函数、方法、类属性和跨模块接口必须有完整类型注解。
- HTTP 请求、模型响应、工具参数、配置与其他外部输入必须使用 Pydantic Schema 校验，不以未经验证的 `dict` 直接进入业务层。
- FastAPI 路由只负责协议适配；业务用例进入 `application`，模型循环与推理编排进入 `engine`。
- 错误应转换为稳定、可测试的领域错误或 HTTP 错误，不向客户端泄露堆栈、凭据和本机敏感路径。

## 3. 模块边界

- `interfaces` 不直接执行工具，不自行构造绕过应用层的运行生命周期。
- `tools` 不绕过 `runtime`；工具只能由 MiniCode Harness Runtime 注册、策略判断并执行。
- `engine` 可以请求工具调用，但不能直接调用文件、Shell 或 Git 副作用实现。
- 大工具结果进入 `ArtifactStore`，上下文只保留必要 preview、摘要和引用。

## 4. Runtime 安全规则

- 文件写入、Shell、Git 写操作必须通过 `PolicyEngine` 与 `ApprovalGate`，不得以辅助脚本、路由或测试捷径绕过。
- 工作区外路径、符号链接逃逸一律拒绝。
- `.ssh`、`.gnupg`、凭据文件和运行时定义的其他敏感目录不可读取。
- 新工具必须声明只读性、副作用、破坏性、审批要求和风险信息，并由 `WorkspaceManager` 处理路径。
- 默认策略是只读；批准只适用于明确的工具调用，不自动授权后续副作用。

## 5. React 与 Web

- React 代码使用函数组件和 TypeScript strict 模式，保持 Vite 构建方式。
- 所有前端 API 请求只通过 `web/src/api.ts`；组件不得散落直接 `fetch` 调用。
- 异步界面必须处理加载、空、错误和审批状态，并在卸载或依赖变化时清理轮询与订阅。
- 保持现有 MiniCode 三栏工作台的视觉语言，不为接入 Harness 强制迁移到 Vue、Pinia 或 Tailwind。

## 6. 测试与完成条件

- 修改行为必须先写测试并观察到与缺失行为一致的失败，再实现最小改动使其通过。
- 默认测试必须离线；禁止真实模型或真实外部服务进入默认测试，不得要求 API Key 或读取用户态 MiniCode 数据。
- Mock 可以替代模型和外部服务，但不得替代 Runtime 的策略、审批和工作区安全决策。
- 测试使用临时工作区和临时 SQLite，不能污染仓库外的用户状态。
- 提交前从仓库根目录执行：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

任一命令失败都必须保留可复现证据，修复后重新执行完整门禁。
