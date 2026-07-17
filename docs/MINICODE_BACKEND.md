# MiniCode 后端规范

## 1. 适用范围

本规范适用于 `src/minicode/` 中的 Python、FastAPI、Pydantic 与 SQLite 代码。架构总览见 [ARCHITECTURE.md](../ARCHITECTURE.md)，详细产品设计见 [项目目标与架构设计](01_项目目标与架构设计.md)。

## 2. 分层与路由

- FastAPI 路由只做 HTTP 输入解析、Schema 校验、调用用例和输出适配，不放置 QueryLoop、工具执行或持久化编排。
- 项目、会话、运行与审批等业务用例进入 `application/`；模型调用、工具调用循环、暂停与恢复进入 `engine/`。
- 路由不得直接调用 `tools/`，也不得自行执行文件、Shell 或 Git 操作。
- 新的跨层依赖应沿 `interfaces -> application -> engine/runtime/context` 方向建立，避免业务层反向依赖 FastAPI。

## 3. Pydantic Schema

- HTTP 请求与响应、工具调用、策略结果、会话和事件等边界对象使用 Pydantic 模型。
- 外部输入在进入业务用例前完成类型、枚举、范围和必填字段校验；业务层不重复猜测输入形状。
- Schema 字段变更必须有兼容性判断和接口测试；持久化 payload 变更还必须覆盖旧记录读取路径。
- Python 公共接口保持完整类型注解，不以宽泛的 `Any` 隐藏边界错误。

## 4. HTTP 错误约定

- HTTP 错误统一使用稳定的状态码与 JSON `detail` 信息，前端不得依赖 Python 异常文本或堆栈。
- 无效输入或非法路径使用 `400`，权限或敏感路径拒绝使用 `403`，资源不存在使用 `404`，并发状态冲突使用 `409`。
- 未预期错误记录服务端诊断信息后返回不含凭据、堆栈和敏感绝对路径的 `500` 响应。
- 相同领域错误在不同路由中保持相同状态码和消息语义，并由 FastAPI 集成测试覆盖。

## 5. SQLite 与事务边界

- 一次用例内必须共同成功或共同失败的状态更新放在同一个显式事务中；离开事务作用域前完成提交，异常时回滚。
- 数据库连接是短生命周期资源，不跨线程、长时间模型调用或 `await` 边界共享。
- 暂停状态、待审批工具调用和恢复所需信息必须先持久化，再向客户端报告 `waiting_approval`。
- 恢复时在事务内校验当前状态与审批决定，保证同一批准或拒绝最多生效一次；唯一约束和条件更新用于阻止重复执行。
- 测试使用独立临时 SQLite 文件，不访问用户主目录下的数据库。

## 6. QueryLoop、Approval API 与并发

- `QueryLoop` 遇到需要审批的工具调用时保存完整恢复点并暂停，不在批准前执行副作用。
- Approval API 只接受明确的 `approve` 或 `reject` 决定；资源不存在返回 `404`，状态不允许或重复决定返回 `409`。
- 批准后从持久化恢复点继续原工具调用；拒绝后记录决定并结束或把结果返回循环，不执行被拒绝的副作用。
- 同一 session 同一时刻最多有一个活动 run。创建竞争 run、并发审批或过期恢复请求必须以可测试的冲突结果失败。
- 内存中的 run 缓存只能用于当前进程协调，不能成为跨 daemon 恢复的唯一事实源。

## 7. Runtime 不可绕过约束

- 所有工具由 MiniCode Harness Runtime 统一注册、判断与执行。
- `PolicyEngine` 必须在执行前结合 `ToolSpec`、`RiskProfile`、模式和参数给出决定。
- `WorkspaceManager` 必须解析每个文件路径，拒绝工作区逃逸、符号链接逃逸和敏感路径。
- `ApprovalGate` 必须绑定具体待执行调用；批准不得扩散为 session 或后续调用的通用写权限。
- 路由、应用服务、QueryLoop 和工具实现不得直接复制一条“快速路径”绕过 Runtime、Policy 或 Workspace 检查。

## 8. pytest 与完成定义

- 纯业务规则写单元测试；路由、SQLite、QueryLoop 暂停/恢复以及 Runtime 边界写集成测试。
- 测试覆盖成功、校验失败、策略拒绝、审批暂停、批准恢复、拒绝、重复决定和并发冲突。
- 模型使用确定性 fake；默认测试不访问真实模型、网络、API Key 或用户态数据库。
- 文件与数据库测试使用 `tmp_path`，安全测试调用真实 `PolicyEngine`、`ApprovalGate` 和 `WorkspaceManager`。

后端变更完成必须同时满足：相关 pytest 先红后绿、完整 Python 测试通过、公共接口类型检查通过、Lint 通过，并且仓库级门禁 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全部成功。
