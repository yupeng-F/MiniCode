# Code Review

> 代码评审规范。专用于 `review` 任务类型。
> 编码规范见 [../PROJECT_RULES.md](../PROJECT_RULES.md)，后端约束见 [CODING_BACKEND.md](CODING_BACKEND.md)。

**产出物**：`docs/review-reports/sprint-N-review.md`（须更新 `index.md`）

---

## 评审维度体系（6 维）

| 维度 | 参考规范 | 核心检查 |
|------|---------|---------|
| 编码规范 | PROJECT_RULES.md Key Rules + Checklist | 全部条目 + 模块职责单一、复杂逻辑有注释 |
| 架构一致性 | 技术方案 + TECH_BACKEND/FRONTEND.md + 设计文档 | 分层正确（Controller→Service→Repository）、前端 Composition API、实现与方案一致、前端 DOM 结构与原型对齐（外框/标题/分块），偏离须有设计变更说明 |
| 安全合规 | CODING_BACKEND.md 安全章节 | 认证、输入校验、数据安全、接口安全、密钥管理 |
| 可靠性 | CODING_BACKEND.md 可靠性章节 | 错误处理、日志、重试、幂等、并发 + 前端 onUnmounted 清理 |
| 性能 | PROJECT_RULES.md 代码质量基线 | 无重复 IO、异步队列、无大表 JOIN、缓存规范、前端无多余重渲染 |
| 可维护性 | PROJECT_RULES.md 编码约束 | 函数 ≤ 50 行、圈复杂度 ≤ 10、无魔法数字、async/await |

## 严重级别

| 级别 | 定义 | 处理 |
|------|------|------|
| Critical | 安全漏洞、数据泄露、生产事故风险 | 必须修复 |
| Major | 违反核心规范、架构不一致、可靠性缺失 | 必须修复 |
| Minor | 可维护性、非关键性能 | 建议修复，不阻塞 |
| Suggestion | 优化建议 | 记录 tech-debt-tracker.md |

**通过标准**：0 Critical + 0 Major + Minor ≤ 5 + `pnpm typecheck && pnpm lint` 通过

---

## 完成标准（DoD）

- 6 维全部检查
- 评审报告已生成（结论 + 问题清单 + 级别）
- Critical/Major 已修复并验证
- 修复后 `pnpm typecheck && pnpm lint && pnpm test` 通过

---

## AI 执行协议

**允许工具**：搜索、文件读取、bash（typecheck/lint/test/audit）、code-review 子代理 | **禁止**：创建新业务文件

**执行步骤**：
1. 确定范围（`git diff --name-only`）
2. 加载规范（PROJECT_RULES + ARCHITECTURE + CODING_BACKEND/FRONTEND + 技术方案）
3. 静态分析（`pnpm typecheck && pnpm lint && pnpm audit`）
4. 6 维 × 每个变更文件逐项检查
5. 生成报告 → 判定通过/不通过 → 不通过派生修复任务
