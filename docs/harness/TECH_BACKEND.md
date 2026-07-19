# 后端技术方案规范

> 后端技术方案设计标准。专用于 `backend-design` 任务类型。
> 架构见 [../../ARCHITECTURE.md](../../ARCHITECTURE.md)，编码约束见 [CODING_BACKEND.md](CODING_BACKEND.md)。

**产出物**：保存至 `docs/tech-docs/`（须更新 `index.md`，关联 User Story ID）

**文档约束**：单份技术方案不超过 **500 行**，**禁止包含代码示例**（用文字、表格、Mermaid 图描述逻辑，代码在编码阶段产生）。超出须按模块拆分。

**渐进式加载**：先读 `docs/tech-docs/index.md`、本次 PRD/设计与 ARCHITECTURE，再只打开相关历史技术方案。新方案必须沉淀对旧实现/旧方案的变更、优化、删除，供 Coding 阶段作为唯一历史上下文来源。

---

## 分层设计

| 层 | 职责 | 禁止 |
|----|------|------|
| Controller | 接收请求、Zod 校验、调用 Service、返回响应 | 业务逻辑、数据库操作 |
| Service | 业务逻辑编排、事务控制 | 直接操作 HTTP Request/Response |
| Repository | 数据库读写，封装 Drizzle 查询 | 业务逻辑判断 |
| DTO | 请求/响应数据结构（Zod Schema + TS 类型） | 运行时逻辑 |

## API 设计

- 所有路由须 Zod Schema（request/response）
- 成功：`{ data, meta }`、失败：`{ code, message, requestId }`
- 写操作：`Idempotency-Key` + Redis 24h、列表：cursor 分页 `{ items, nextCursor, total }`
- 公开路由显式 `{ auth: false }`，默认 JWT 认证

## 数据库设计

- 统一通过 Repository 访问，迁移只增不改
- 慢查询阈值 200ms 须加索引、不使用外键（应用层保证）、禁止大表 JOIN

## 缓存设计

- Key：`[模块]:[资源]:[id]`、TTL 显式设置、写操作同步失效（Cache-Aside）

## 错误处理

- 统一错误码（`src/types/errors.ts`）、`AppError(code, message)` 抛出、Fastify `setErrorHandler` 捕获

> 安全设计详见 [CODING_BACKEND.md](CODING_BACKEND.md) 安全章节（JWT/RBAC/输入验证/Rate Limiting 等）

---

## 设计原则

> 技术方案设计和评审时须遵循的经典设计原则。

| 原则 | 说明 | 后端关注点 |
|------|------|-----------|
| **单一职责（SRP）** | 每个模块/类/函数只承担一个职责，变更原因应唯一 | Controller 不含业务逻辑，Service 不操作 HTTP |
| **开闭原则（OCP）** | 对扩展开放，对修改关闭 | 新增功能通过新 Service/Strategy 扩展，不改已有方法签名 |
| **依赖倒置（DIP）** | 高层模块不依赖低层实现，两者依赖抽象 | Service 依赖 Repository 接口，不依赖 Drizzle 细节 |
| **接口隔离（ISP）** | 不强迫使用者依赖不需要的接口 | DTO 按消费者拆分，避免万能 God Object |
| **里氏替换（LSP）** | 子类型必须能替换基类型而不破坏正确性 | 错误码体系统一，AppError 子类行为一致 |
| **组合优于继承** | 优先组合/委托复用行为，继承层级不超过 2 层 | 工厂函数 + 依赖注入，不用类继承 |
| **最少知识（LoD）** | 对象只与直接协作者交互 | Controller 不穿透 `svc.repo.db` 链式调用 |

---

## 技术方案必须章节

1. **功能概述**：问题 + User Story
2. **模块设计**：Controller/Service/Repository 职责 → 分层设计
3. **数据模型**：DB Schema 变更 → 数据库设计
4. **接口定义**：路径/方法/Schema/错误码 → API 设计
5. **核心流程**：Mermaid 时序图（主路径 + 异常）
6. **缓存/队列**：Redis Key + MQ topic（如涉及）→ 缓存设计
7. **性能设计**：慢查询/索引/并发策略
8. **安全设计**：权限/校验/敏感数据 → CODING_BACKEND.md

---

## AI 执行协议

**允许工具**：文件读写/搜索、explore 子代理、`fastify-best-practices`、`drizzle-orm` | **禁止**：bash 执行、代码修改

> **知行合一**：技术方案须结合框架最佳实践验证可行性。

**自检清单**：
- 分层正确（Controller→Service→Repository）、接口含 Zod Schema + 错误码
- 数据模型迁移定义、无外键、慢查询有索引
- 缓存 Key 命名规范 + TTL、异常用统一错误码无 stack trace
- 写操作幂等、外部 API 有重试策略
