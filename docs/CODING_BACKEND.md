# 后端编码规范

> 后端 `code` 任务的编码约束与完成标准。专用于 `code` 任务类型（后端）。
> 技术方案见 [TECH_BACKEND.md](TECH_BACKEND.md)，线上观测见 [OBSERVABILITY.md](OBSERVABILITY.md)。

---

## 上下文边界

Coding 只读取本次迭代 PRD、设计、技术方案与项目编码规范。不得回读历史 PRD/设计/技术方案作为实现依据；历史变更、优化、删除必须已经沉淀在本次迭代技术方案中。

---

## 可靠性

### 错误处理

- **禁止空 catch**，至少记录日志
- 统一响应格式：`{ code: string, message: string, requestId: string }`
- 错误码定义于 `src/types/errors.ts`，使用 `AppError(code, message)` 抛出
- 禁止暴露 stack trace

### 日志（Pino）

- 生产级别：`info`；每条含 `requestId`（链路追踪）；敏感字段脱敏

### 重试 / 幂等 / 并发

- 外部 API：timeout + 指数退避（retries: 3, factor: 2, 500-5000ms）
- 写操作：`Idempotency-Key` Header，Redis 缓存 24h
- 高并发链路：Redis 队列异步化，热路径无重复 IO

---

## 安全

| 领域 | 要求 |
|------|------|
| 认证 | JWT（HttpOnly Cookie）、Access 15min / Refresh 7d、RBAC owner/member/viewer |
| 输入验证 | 路由层 Zod Schema、URL 防 SSRF（屏蔽内网 IP）、文件上传校验 MIME+大小、富文本 DOMPurify |
| 数据安全 | ORM 参数化查询（禁止拼 SQL）、密码 bcrypt ≥ 12 rounds、IP 脱敏至城市、手机/邮箱掩码 |
| 接口安全 | Rate Limiting（生成 10/min/user，上报 1000/min/IP）、CORS 白名单（禁通配符）、`@fastify/helmet` 安全头 |
| 密钥 | 禁止提交代码仓库、仅提交 `.env.example`、GCP Secret Manager 注入、`pnpm audit` 无 High/Critical |

涉及认证/支付/访问控制变更须安全专项审查。

---

## 完成标准（DoD）

- `pnpm typecheck && pnpm lint && pnpm test` 全部通过，覆盖率 ≥ 80%
- `node scripts/verify.mjs health` 通过（API 返回 200）
- 涉及用户可见链路的变更须有 `e2e/scenarios/` 下对应的 E2E 场景用例
- 新增/变更 API 已更新文档、`.env.example` 已更新、DB 迁移文件已新增
- 技术债记录到 `tech-debt-tracker.md`

---

## AI 执行协议

**允许工具**：文件读写/搜索、bash（build/test/lint）、子代理、`fastify-best-practices`、`drizzle-orm` | **禁止**：修改规范文档

**代码生成约束清单**：
- 错误处理：无空 catch + AppError 统一错误码 + 日志含 requestId + 敏感脱敏
- 重试/幂等/并发：外部 API 指数退避 + 写操作 Idempotency-Key + 高并发异步队列
- 安全：JWT 认证 + Zod 校验 + ORM 参数化 + Rate Limiting + CORS 白名单 + 无密钥硬编码 + DOMPurify
