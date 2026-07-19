# 前端编码规范

> 前端 `code` 任务的编码约束与完成标准。专用于 `code` 任务类型（前端）。
> 技术方案见 [TECH_FRONTEND.md](TECH_FRONTEND.md)。

---

## 上下文边界

Coding 只读取本次迭代 PRD、设计、技术方案与项目编码规范。不得回读历史 PRD/设计/技术方案作为实现依据；历史变更、优化、删除必须已经沉淀在本次迭代技术方案中。

---

## 完成标准（DoD）

**通用**：`pnpm typecheck && pnpm lint && pnpm test` 通过，覆盖率 ≥ 80%，技术债记录到 `tech-debt-tracker.md`

**前端附加**：
- **浏览器联调必须执行**：使用 `webapp-testing` 或 `chrome-devtools` 验证，禁止 curl/单测替代
- **联调截图交付**：每个任务产出 Playwright 截图证明渲染和交互正常
- **E2E 场景用例**：新增/变更的业务链路须有 `e2e/scenarios/` 下对应的 Playwright Test 用例
- **侦察优先**：先截图确认实际 DOM，再写测试断言，禁止盲猜 selector
- **修改现有优先**：新增文件须在技术方案中说明理由
- **原型保真**：实现保留原型的容器/标题区/卡片/气泡的结构与层级；原型示例的所有内容类型/状态在实现端可被看到
- **契约由代码守护**：`node scripts/check-prototype-coverage.mjs --sprint <id>`、`node scripts/check-contract-strength.mjs --sprint <id>`、`node scripts/ui-audit.mjs --sprint <id>` 全部 PASS

---

## 安全约束

- 富文本 DOMPurify、用户输入 Zod 客户端校验（后端校验仍必须）
- 禁止前端硬编码 API Key/Secret、JWT 仅通过 HttpOnly Cookie

---

## 前后端联调

**前置**：后端 API 完成 + 文档更新 + 服务可启动

**流程**：启动后端 → 启动前端 → `node scripts/verify.mjs health screenshot` → `chrome-devtools`/`webapp-testing` 补充验证 → 问题即修

**验证清单**：DB 迁移完成 + 后端健康 + 前端渲染正常 + API 调用正确 + 状态切换正确 + 表单闭环 + Console 无异常 + 主路径 E2E 走通

**产出物**：Playwright 截图 + DOM 侦察结果 + 验证清单（缺截图 → AI REVIEW 标记 `incomplete`）

---

## AI 执行协议

**允许工具**：文件读写/搜索、bash（build/test/lint）、子代理、`vue-best-practices`、`chrome-devtools`、`webapp-testing` | **禁止**：修改规范文档

**代码生成约束清单**：
- 组件 `<script setup lang="ts">`，禁止 Options API
- 状态：局部 ref vs 全局 Pinia store 划分正确
- API 封装在 `services/`，禁止组件直接 fetch
- 路由 `meta.requiresAuth` 标注、命名 kebab-case
- 性能：LCP < 2s、H5 无 Vue 运行时
- 命名：组件 PascalCase、Store useXxxStore
- 安全：DOMPurify + 无硬编码密钥
- 联调产出物完整
