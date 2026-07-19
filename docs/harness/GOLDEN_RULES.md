# 黄金原则（Golden Rules）

> 从 Bug 根因、评审 Major、重构经验中提炼的通用工程品味规则。
> 适用于所有 Harness 项目。成熟规则升级为 Lint（第1层前置阻断）。

## 原则列表

| # | 原则 | 检查方式 | Lint 规则 |
|---|------|---------|----------|
| G-1 | **优先共享工具库**：禁止在模块内手写重复 helper，提取到 `shared/` | Lint（pre-commit + CI） | `harness/no-duplicate-helper` |
| G-2 | **禁止 YOLO 探测数据**：所有外部输入必须边界校验或 SDK 强类型访问 | Lint（pre-commit + CI） | `no-explicit-any`（项目启用） |
| G-3 | **不变式集中管理**：魔法数字、业务常量、配置阈值集中到 `config/` 或 `shared/constants` | Lint（pre-commit + CI） | `harness/no-magic-values` |
| G-4 | **禁止 GPL 依赖**：不得引入 GPL/AGPL 协议的框架或组件，避免开源协议污染；选型时须确认为 MIT/Apache-2.0/BSD 等宽松协议 | `pnpm audit` / CI | — |
| G-5 | **E2E 场景覆盖关键链路**：用户可见的业务链路须有 `e2e/scenarios/` 下对应的 Playwright Test 用例，覆盖正常路径 + 主要异常路径 | `pnpm test:e2e` + CI code-garden | — |
| G-6 | **写操作必须幂等**：POST/PUT/PATCH 端点须支持 `Idempotency-Key` 或业务天然幂等（如 upsert），防止网络重试导致重复数据 | Code Review | — |
| G-7 | **外部链路保留真实证据**：涉及第三方能力、媒体持久化、支付、消息发送、AI 推理等用户可见外部链路时，测试用例至少 1 条声明 `execution.mode: live`，质量报告须记录真实链路结果。执行 live 用例时，缺失的真实 KEY / 账号通过 `ask_user` 向用户补充；仅当用例 `execution.mock_reason` 字段明确声明不可测原因（如第三方服务受可信域名 / 可信 IP 限制无法在本地 Docker 测试）时，允许使用 Mock 替代 | `quality-score.mjs` + 产品走查 | — |
| G-8 | **本地 Docker 统一运行**：本地联调、API/E2E/UI 还原度/产品走查统一基于 `docker compose` 容器（中间件 + API + Web + Mock），客户端程序在宿主机运行；细则见 [G-8 代码化要点](#g-8-代码化要点) | `verify.mjs` + `sprint-gate.mjs` | — |

<!-- 持续补充：Bug 根因 → 黄金原则 → code-garden 验证 → Lint 固化 -->

### G-8 代码化要点

- 项目通过 `docker-compose.yml` 声明所有容器（中间件 + API + Web + Mock）。
- `verify.config.sh` 配置：
  - `DOCKER_COMPOSE_FILE` — compose 文件路径
  - `DOCKER_BUILD_SERVICES` — 按源码重建的服务（通常 `api web`）
  - `APP_START_SERVICES` — `up -d --wait` 启动的服务
  - `MOCK_SERVICE_NAME` — Mock 服务名；纯后端 Sprint 可显式置 `NONE` opt-out
- **唯一启动入口** `verify.mjs docker-up`：`down → 按源码 build → up -d --wait`。
- **幂等 health** `verify.mjs health`：先检测目标服务是否已 healthy，是则跳过；否则委托 `docker-up`。
- **每任务前置** `sprint-gate.mjs` 自动调用 `verify.mjs preflight`，缓存 TTL 来源 `task-rules.yml.sprint_preflight.ttl_seconds`，关键文件 mtime 变更立即失效。
- **数据安全** `verify.mjs docker-down` 默认保留 volume；销毁数据需显式 `--purge`。

## 执行层级

```
品味观察 → 黄金原则（本文档）→ Lint 前置阻断（pre-commit + CI）
```

| 层级 | 工具 | 时机 | 触发确定性 |
|------|------|------|-----------|
| 前置阻断 | `lint/harness-plugin.mjs` | pre-commit hook + CI workflow | ✅ 确定 |
| 模块健康 | `node scripts/code-garden.mjs --ci` | CI workflow | ✅ 确定 |
| 文档定义 | 本文件 | Agent 编码/评审时加载 | 参考 |

## 新增规则流程

1. 从 Bug 根因、评审 Major、重构痛点中识别模式
2. 编码为黄金原则（本文档新增行）
3. 新增 ESLint 规则（`harness-plugin.mjs`）— CI + pre-commit 自动阻断
4. 如需模块级扫描，在 `code-garden.mjs` 中添加（CI 自动运行）
