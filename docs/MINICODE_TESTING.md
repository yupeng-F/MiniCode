# MiniCode 测试与失败证据规范

## 1. 目标

MiniCode 测试既验证产品行为，也验证本地 Agent 的安全边界。测试默认离线、可重复、与用户状态隔离；不能为了缩短测试而绕过 MiniCode Harness Runtime。

## 2. 四层测试

### 2.1 单元测试

- Python 使用 pytest 验证 Pydantic Schema、策略规则、上下文预算、压缩和纯业务逻辑。
- Web 使用 Vitest 验证 `web/src/api.ts`、状态转换、组件分支与轮询清理。
- 单元测试快速、确定，不依赖网络、真实模型或持久用户目录。

### 2.2 集成测试

- pytest 验证 FastAPI 路由、application/engine 编排、SQLite 事务、QueryLoop 暂停/恢复与 Runtime 工具链。
- 安全集成测试必须使用真实 `PolicyEngine`、`ApprovalGate`、`WorkspaceManager` 和工具注册信息。
- 集成测试覆盖成功路径，也覆盖路径逃逸、敏感目录、拒绝、重复审批和并发冲突。

### 2.3 冒烟测试

- 冒烟测试离线启动真实 CLI Mock 入口和 FastAPI `TestClient`，验证主要入口能在临时工作区完成最小路径。
- 冒烟测试不等同完整 E2E，不调用真实模型，也不读取用户级 MiniCode 状态。

### 2.4 后续 Playwright 用户旅程

- Playwright 属于后续建设层，用于项目打开、创建会话、展示工具调用、审批、恢复和结果查看等浏览器旅程。
- 在 Playwright 套件落地前，不把 `test:e2e` 的离线冒烟结果描述成完整浏览器 E2E 覆盖。

## 3. pytest 与 Vitest 的边界

- pytest 负责 Python 后端、CLI、FastAPI、SQLite、QueryLoop、Context、Memory、Runtime 与工具安全行为。
- Vitest 负责 TypeScript API Client、React 组件和前端状态逻辑。
- 跨前后端契约通过双方对同一字段和错误语义的测试保持一致；浏览器端到端联动留给后续 Playwright。

## 4. Mock 边界

- Mock 或 fake 只替代模型、网络和不可控外部服务，并返回确定性结果。
- 不 Mock `PolicyEngine` 的允许或拒绝结论，不 Mock `ApprovalGate` 的状态转换，不 Mock `WorkspaceManager` 的路径判断。
- 文件写入、Shell 与 Git 写操作的测试仍需通过 Runtime 入口，并在临时 workspace 内执行无破坏性的最小样例。
- 默认测试禁止真实模型；不得读取或要求 API Key，也不得把环境变量值打印到失败输出。

## 5. 隔离与数据

- Python 文件测试使用 pytest `tmp_path`；每个测试创建独立临时目录、workspace、Artifact 目录和临时 SQLite 文件。
- Web 测试恢复 fetch、timer 和全局对象，避免状态泄漏到下一个用例。
- 测试不能读写 `~/.minicode`、真实项目数据库、真实 Git 远端或工作区外文件。
- 固定 fixture 不包含凭据、个人路径和依赖在线时序的内容。

## 6. 真实模型测试

- 真实模型测试必须使用显式标记，与默认测试命令分开运行，并由操作者主动提供受控环境。
- 默认 `pnpm test`、pytest、Vitest 和冒烟测试必须排除真实模型标记。
- 真实模型失败不能用来掩盖离线门禁失败；其日志同样不得记录 prompt 中的敏感内容或 API Key。

## 7. 当前门禁命令

从仓库根目录顺序执行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

提交前的等价快速失败命令是：

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

相关改动还应先运行最小测试定位问题，再执行完整门禁。任一步非零退出都表示门禁失败，不以其他步骤成功替代。

## 8. 失败证据格式

失败报告至少包含：

```text
命令：<完整可复现命令>
退出码：<整数>
失败用例：<测试文件与用例名，非测试命令写检查阶段>
期望：<应满足的行为>
实际：<去除凭据后的关键 stdout/stderr>
环境：<Python、Node.js、pnpm 版本及必要平台信息>
复现：<从仓库根目录执行的最短步骤>
```

不得只写“测试失败”。日志较长时保存为 Artifact，并在报告中给出路径、摘要和关键错误行；任何证据都必须先清除凭据与用户敏感路径。
