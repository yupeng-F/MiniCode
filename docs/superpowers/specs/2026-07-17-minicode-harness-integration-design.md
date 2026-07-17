# MiniCode Harness 接入设计

## 1. 目标

在不修改 `/Users/fish/Code/harness` 的前提下，将 Harness Engineering 接入
MiniCode。MiniCode 在项目内部提供 Harness 命令兼容层，并为 Python/FastAPI、
React/Vite 技术栈提供项目专属规范覆盖层。

接入完成后，Harness 应能正确规划、执行、评审和验证 MiniCode 的开发任务，
不得把 MiniCode 错误识别为 Fastify/Vue 项目。

## 2. 非目标

- 不修改 Harness Engineering 源代码。
- 不把 MiniCode 从 React 迁移到 Vue，也不把 Python 后端迁移到 Node.js。
- 不替换 MiniCode 内部的 `HarnessRuntime`；它是产品组件，与外部研发框架不同。
- 本阶段不建设 Test/Production 部署和云原生交付。
- 自动化测试不调用真实大模型，不要求提供 API Key。
- 本阶段不建设完整的 Playwright 用户旅程测试集。

## 3. 语言约束

- 新增设计文档、实施计划、项目说明和代码注释统一使用中文。
- 技术标识符、API、类名、函数名、命令、文件路径保持英文。
- 没有通用中文译法的术语可以保留英文，但首次出现时应说明含义。
- 注释用于解释设计原因、边界和非显然行为，不逐行翻译代码。

## 4. 术语与所有权

- **Harness Engineering**：安装到 MiniCode 的外部研发治理框架。
- **MiniCode Harness Runtime**：MiniCode 内部负责安全执行工具的运行时边界。
- **Harness 共享文件**：由 Harness 安装器复制，后续同步可能覆盖的文件。
- **MiniCode 覆盖层**：每次 Harness 同步后重新应用的项目配置和项目规范。

Harness 负责通用工作流。MiniCode 负责自身架构、技术选型、验证命令和项目验收标准。

## 5. 总体架构

接入由三个 MiniCode 自有层组成：

1. 根目录 pnpm 接口：暴露 Harness 已经固定调用的命令名。
2. 模块化 Node.js 适配器：执行 MiniCode 真实的 Python 和 Web 检查。
3. 项目规范覆盖层：把任务规则从 Fastify/Vue 假设重定向到 MiniCode 规范。

```text
Harness 任务或质量脚本
        |
        v
pnpm typecheck | lint | test | build | test:e2e
        |
        v
tools/harness-check.mjs
        |
        +--> Python：mypy / ruff / pytest / build
        +--> Web：TypeScript / ESLint / Vitest / Vite

Harness 同步
        |
        v
pnpm harness:overlay
        |
        v
恢复 MiniCode 任务规范引用和验收条件
        |
        v
pnpm harness:doctor
```

## 6. 命令适配器

### 6.1 对外接口

MiniCode 根目录 `package.json` 提供以下脚本：

| 脚本 | 用途 |
|---|---|
| `pnpm typecheck` | Python 与 Web 类型检查 |
| `pnpm lint` | Python/Web Lint 与依赖一致性检查 |
| `pnpm test` | Python 与 Web 单元/集成测试 |
| `pnpm build` | 构建 Python wheel 和 Web 生产包 |
| `pnpm test:e2e` | 离线 CLI/Web 冒烟测试 |
| `pnpm harness:overlay` | Harness 同步后重新应用 MiniCode 任务覆盖 |
| `pnpm harness:doctor` | 检查文件、依赖、命令和覆盖层状态 |

### 6.2 内部模块

```text
tools/
  harness-check.mjs          # CLI 入口与命令分发
  harness/
    command-runner.mjs       # 顺序执行进程并快速失败
    config-loader.mjs        # 加载并校验 MiniCode 适配配置
    overlay.mjs              # 确定性转换 task-rules.yml
    doctor.mjs               # 只读检查安装和配置状态
```

入口文件保持精简。每个模块只承担一个职责，并能脱离完整 Harness 流程独立测试。

### 6.3 命令配置

`config/minicode-harness.yml` 是 MiniCode 适配层的单一真相源。命令使用“可执行文件 +
参数数组”表示，不保存为 Shell 字符串，避免转义差异和命令注入歧义。

初始命令图：

| 阶段 | 按顺序执行的命令 |
|---|---|
| `typecheck` | `python -m mypy src/minicode`；`npm --prefix web run typecheck` |
| `lint` | `python -m ruff check src/minicode tests`；`python -m pip check`；`npm --prefix web run lint`；`npm --prefix web audit --audit-level=high` |
| `test` | `python -m pytest`；`npm --prefix web test` |
| `build` | `python -m build --wheel`；`npm --prefix web run build` |
| `test:e2e` | `python -m pytest tests/test_harness_smoke.py` |

命令顺序执行。第一个非零退出结果立即终止阶段，适配器返回同一非零结果。标准输出和
标准错误直接透传，使 Harness 和 CI 保留原始失败证据。

## 7. 最小冒烟覆盖

`tests/test_harness_smoke.py` 覆盖两个离线产品入口：

1. 启动 `python -m minicode.interfaces.cli --mock --workspace <临时目录>`，验证程序成功
   结束并输出 Mock Tool-Use Loop 的最终结果。
2. 使用 FastAPI `TestClient` 和临时全局数据库路径请求 `/`，验证应用名称和架构描述。

这是真实的 CLI/Web 冒烟测试，但不是最终用户旅程 E2E。完整 Playwright 场景在
Harness 安装后通过后续 Feature Sprint 增加。

## 8. MiniCode 项目规范

新增以下 MiniCode 自有文档：

| 文件 | 职责 |
|---|---|
| `ARCHITECTURE.md` | Harness 架构入口；详细架构指向 `docs/01_项目目标与架构设计.md` |
| `PROJECT_RULES.md` | Python/React 规则、模块边界、Runtime 安全不变式和提交前要求 |
| `USER_STORIES.md` | 产品待办及可自动验证的验收标准 |
| `docs/MINICODE_BACKEND.md` | FastAPI、Pydantic、SQLite、错误处理、持久化与并发规范 |
| `docs/MINICODE_FRONTEND.md` | React、Vite、API Client、UI 状态、可访问性与构建规范 |
| `docs/MINICODE_TESTING.md` | pytest/Vitest/冒烟测试分层、Mock 边界、覆盖率与真实模型测试规则 |

这些文档只描述 MiniCode。通用 Sprint、评审、发布和可观测性规范继续由 Harness
Engineering 维护。

## 9. 任务规则覆盖层

Harness 安装器会复制 `lint/task-rules.yml`，其中当前前后端规则带有 Vue/Fastify
假设，MiniCode 不能直接采用这些引用和验收条件。

`config/minicode-harness.yml` 为以下任务声明确定性覆盖：

- `design`：加载通用设计哲学与 `docs/MINICODE_FRONTEND.md`，不加载 Vue 专属基线。
- `backend-design`：加载 `docs/MINICODE_BACKEND.md`。
- `frontend-design`：加载 `docs/MINICODE_FRONTEND.md`。
- `code`：加载 MiniCode 前后端规范和验证命令，同时保留通用代码评审规范。
- `test-case-gen` 与 `quality`：使用 `docs/MINICODE_TESTING.md` 定义项目测试结构和证据。

覆盖程序只修改配置明确声明的字段。与 MiniCode 无关的 Harness 任务和未来新增的未知
字段保持不变。连续应用两次后任务语义完全一致，即操作必须幂等。

每次 Harness 同步后执行：

```bash
pnpm harness:overlay
pnpm harness:doctor
```

如果任务规则仍包含 Vue/Fastify 验收条件、MiniCode 规范缺失、命令依赖不可用，或者
覆盖层尚未应用，`doctor` 必须返回非零结果。

## 10. 工具链变更

Python 开发依赖增加：

- `pytest`
- `mypy`
- `ruff`
- `build`

Web 增加明确的 `typecheck`、`lint` 脚本以及 React/TypeScript 所需的最小 ESLint
依赖。现有 npm 管理的 `web/package-lock.json` 继续作为 Web 依赖真源。根目录 pnpm
只作为 Harness 命令入口和覆盖工具宿主。

根目录包只增加用于校验命令和覆盖配置的 YAML 解析器，不引入通用任务运行器。

## 11. 错误处理与安全边界

- 未知适配阶段输出用法并返回非零结果。
- YAML 字段缺失或非法时，在执行命令或写覆盖文件前失败。
- 覆盖程序写入前解析并验证 MiniCode 仓库根目录。
- 覆盖程序只能写 MiniCode 仓库内的 `lint/task-rules.yml`。
- `doctor` 始终只读。
- 冒烟测试只使用临时目录和临时 SQLite 文件。
- 测试不得读取用户级 MiniCode 状态或真实 API 凭据。
- 命令输出不得打印环境变量值。

## 12. 验证策略

实施过程遵循测试驱动开发：

1. 先测试配置校验与命令计划。
2. 使用可控子进程测试快速失败和退出码传播。
3. 使用临时 YAML 测试任务覆盖转换及幂等性。
4. 测试 `doctor` 对缺失文件和过期覆盖层的错误说明。
5. 先增加失败的 CLI/Web 冒烟测试，再实现必要接线。
6. 单独执行每个公开 pnpm 命令。
7. 执行完整 Python 与 Web 测试集。
8. 确认 `/Users/fish/Code/harness` 没有修改。

## 13. 交付顺序

1. 实现并验证 MiniCode 兼容层和项目规范。
2. 单独提交兼容层。
3. 对 MiniCode 执行 Harness `--dry-run`。
4. 使用 `--no-commit` 安装 Harness。
5. 重新应用 MiniCode 覆盖层并运行 `doctor`。
6. 检查安装 Diff，单独提交 Harness 安装结果。
7. 从 `USER_STORIES.md` 启动第一个 Harness Feature Sprint。

