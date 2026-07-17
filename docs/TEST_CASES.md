# 测试用例生成规范

> 专用于 `test-case-gen` 任务类型。定义测试用例的优先级体系、结构、生成方法和目录规范。

---

## 优先级体系

| 级别 | 定义 | 回归策略 |
|------|------|---------|
| P0 | 核心业务链路（用户无法绕过） | 每次 Sprint 必须回归 |
| P1 | 主要功能路径（影响体验但有替代方案） | 当前迭代全量执行 |
| P2 | 边界/异常场景 | 当前迭代全量执行 |

---

## 测试用例结构

每个测试用例为一个 YAML 文件，扁平存放于 `test-cases/` 根目录（不再按 Sprint 建子目录）。后续 Sprint 可以修改既有用例，测试用例始终描述系统最新状态。

**字段定义**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 唯一标识，格式 `TC-XXX` |
| `title` | string | ✅ | 用例标题 |
| `priority` | enum | ✅ | `P0` / `P1` / `P2` |
| `introduced_in` | string | ✅ | **首次引入** Sprint 标识（不变） |
| `last_modified_in` | string | ✅ | **最近一次修改用例定义** 的 Sprint 标识 |
| `last_verified_in` | string | ✅ | **最近一次验证通过/修订** 的 Sprint 标识 |
| `preconditions` | string[] | ✅ | 前置条件列表 |
| `steps` | object[] | ✅ | 步骤列表，每步含 `action` + `expected` |
| `tags` | string[] | ✅ | 分类标签 |
| `spec` | string | ✅ | 对应 Playwright spec 路径 |
| `execution` | object | — | 执行模式；默认 `mode: standard`。支持 `mode: live` + `env`，用于声明真实链路 smoke |
| `test_titles` | string[] | — | 该 YAML 对应的具体 Playwright `test(...)` 标题列表；当一个 `spec` 内含多个测试时用于精确映射 |

**模板参考**：`templates/test-case-template.yml`

---

## 生成方法论

### 最新状态原则

测试用例与 Code 一样，始终描述系统最新状态，不按 Sprint 保留旧流程副本。生成前必须先检索 `test-cases/index.md` 与相关 YAML；若业务流程变化，直接修改既有用例并更新 `last_modified_in` / `last_verified_in`。只有没有任何既有用例覆盖当前业务场景时，才新增 `TC-*.yml`。

### 来源推导

| 来源 | 推导方式 | 默认优先级 |
|------|---------|-----------|
| PRD 用户旅程 | 每条旅程至少 1 个用例 | P0 |
| 设计文档页面状态 | 正常/空态/加载/错误各 1 个 | P1 |
| 技术方案边界条件 | 接口超时/数据异常/并发 | P2 |

**真实链路规则**：

- 涉及第三方能力、媒体持久化、支付、消息发送、AI 推理等**用户可见外部链路**时，当前 Sprint 至少 1 个 P0 用例声明 `execution.mode: live`
- `execution.env` 仅放非敏感运行开关（如 `E2E_LIVE_AI_IMAGE=1`）；密钥继续走 `.env`
- `quality-score.mjs` 会按 `execution.mode: live` 单独执行这些用例，并把结果写入质量报告

### 用例扩展方法

| 方法 | 适用场景 | 示例 |
|------|---------|------|
| 等价类划分 | 输入域有多个有效/无效区间 | 用户名长度 1-50 / 空 / 超长 |
| 边界值分析 | 数值或长度有边界 | 最小值、最大值、边界 ±1 |
| 状态迁移 | 对象有多个状态转换 | 订单 待支付→已支付→已取消 |
| 错误猜测 | 基于经验推测常见错误 | 网络断开、重复提交、并发冲突 |
| 交互组合 | 多个独立功能联动 | 筛选 + 排序 + 分页 |

---

## 目录结构

```
test-cases/
├── index.md                    ← 用例索引（模板: templates/test-cases-index.md）
├── TC-001.yml
├── TC-002.yml
└── ...
```

`index.md` 必须记录每个 case 的 `introduced_in`、`last_modified_in`、`last_verified_in`，用于区分"本迭代新增/修改覆盖"与"历史 P0 回归"。

---

## Playwright 映射

每个 `.yml` 用例通过 `spec` 字段映射到 `e2e/scenarios/*.spec.ts`：

- YAML `spec` 字段值 = Playwright 测试文件相对路径
- 当同一 `spec` 文件内存在多个 `test(...)` 时，可通过可选字段 `test_titles` 精确映射到具体测试标题
- 映射关系记录在 `test-cases/index.md`
- `quality` 任务的 `quality-score.mjs` 据此执行当前迭代新增/修改 case 全量 + 历史 P0 回归
- 声明 `execution.mode: live` 的用例会按 `execution.env` 再执行一次真实链路 smoke；该结果与当前迭代 E2E 一起计入质量门

---

## AI 执行协议

**允许工具**：file-rw、search、explore

**禁止工具**：bash、modify-code

**执行步骤**：

1. 读取 `test-cases/index.md`，查找是否已有覆盖当前业务场景的 case
2. 已有 case：更新该 YAML，使其反映系统最新状态，并更新 `last_modified_in` / `last_verified_in`
3. 无覆盖 case：创建新的 `test-cases/TC-*.yml`，填写 `introduced_in` / `last_modified_in` / `last_verified_in`
4. 按来源推导表补齐优先级（PRD → P0，设计 → P1，方案 → P2）和边界/异常用例
5. 将执行抽象写入或复用 `e2e/scenarios/*.spec.ts`；多个 case 可共用同一 spec
6. 更新 `test-cases/index.md` 的引入/修改/验证 Sprint 与 spec 映射
