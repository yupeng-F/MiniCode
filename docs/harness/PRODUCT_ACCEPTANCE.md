# Product Acceptance（产品走查规范）

> 测试环境产品走查。专用于 `product-acceptance` 任务类型。
> 产品原则见 [PRODUCT_SENSE.md](PRODUCT_SENSE.md)，设计规范见 [DESIGN.md](DESIGN.md)。

**产出物**：`docs/acceptance-reports/sprint-N-walkthrough.md` + `sprint-N-acceptance.md`  
**审批记录**：Boss 确认后生成 `docs/acceptance-reports/sprint-N-boss-signoff.yml`

## 前置条件

| 条件 | 验证方式 |
|------|---------|
| 环境就绪 | `node scripts/verify.mjs preflight` 全部 ✅（基础设施 + DB + 环境变量） |
| 质量评分 ≥ 95 | `quality` 任务报告 |
| 当前迭代 E2E 通过 | 质量报告含 `当前迭代: ✅ 通过` |
| 历史 P0 回归通过 | 质量报告含 `P0 回归: ✅ 通过` |
| 存在 live 用例时真实链路通过 | 质量报告含 `真实链路: ✅ 通过` |
| PRD + 设计文档存在 | `product-specs/` + `design-docs/` |
| 全栈环境运行中 | `node scripts/verify.mjs health` 双端 200 |

> Preflight 失败时，输出缺失项和配置指引，等待用户完成配置后重新运行。

## 测试环境启动协议

> 产品走查在全栈环境下执行。

1. **Preflight**：`node scripts/verify.mjs preflight` — 校验基础设施、数据库、环境变量
2. **启动服务**：`node scripts/verify.mjs health` — 启动后端 + 前端，双端健康检查
3. **Preflight 或 Health 任一失败** → 输出具体修复命令 → 等待用户确认后重试

## 偏差严重级别

| 级别 | 定义 | 处理 |
|------|------|------|
| 🔴 Critical | 功能缺失/不可用，阻断主路径 | 必须修复 |
| 🟠 Major | 与 PRD/设计明显偏差，影响体验 | 必须修复 |
| 🟡 Minor | 细节偏差，不影响主路径 | ≤ 5 个可放行 |
| 🔵 Observation | 优化建议 | 不阻碍发布 |

**通过标准**：0 Critical + 0 Major + Minor ≤ 5 + PRD 覆盖 100% + 产品主张 ≥ 4/5 + 核心状态全覆盖

## 走查维度

### 维度一：PRD 功能符合性（F-01~F-08）

| 编号 | 检查内容 | 判定标准 |
|------|---------|---------|
| F-01 | 主路径完整 | 按 PRD 用户流程逐步执行无阻断 |
| F-02 | 异常路径覆盖 | 异常态有处理，不白屏不卡死 |
| F-03 | 字段完整性 | 所有字段存在、类型正确 |
| F-04 | 状态完备性 | 正常/空态/加载/错误/降级态均有 UI |
| F-05 | 默认值策略 | 与 PRD 一致，体现产品策略 |
| F-06 | 文案准确性 | 与 PRD 定义一致 |
| F-07 | 数据埋点 | PRD 定义的埋点全部触发 |
| F-08 | 非功能要求 | 满足 P50/P95/P99 指标 |

### 维度二：UI 设计符合性（U-01~U-08）

| 编号 | 检查内容 | 判定标准 |
|------|---------|---------|
| U-01 | 页面流完整 | 所有页面已实现，导航路径与设计一致，每页 prototype-vs-live 截图对比通过（`coverage/ui-audit.json` passed=true） |
| U-02 | 视觉层级 | 信息层级与设计一致 |
| U-03 | 布局与间距 | 关键间距偏差 ≤ 4px |
| U-04 | 组件状态 | default/hover/active/loading/disabled 全覆盖 |
| U-05 | 响应式 | 375px + 1280px 断点正确 |
| U-06 | 动效 | 120-300ms，缓动与设计一致 |
| U-07 | Design Token | 可追溯到 token，无硬编码样式 |
| U-08 | 首屏规范 | 1 个主任务 + 1 个主 CTA |

### 维度三：产品主张符合性（P1~P5）

> 每条主张独立评分，≥ 4/5 通过。判定标准源自 [PRODUCT_SENSE.md](PRODUCT_SENSE.md)。

| 主张 | 核心检查 |
|------|---------|
| P1 速度是功能 | P99 < 8s、LCP < 2s、交互反馈 < 100ms、乐观更新 |
| P2 零摩擦 | 主路径 ≤ N 步、每步 ≤ 1 决策、自动推断、自然语言优先 |
| P3 默认值即观点 | 有默认选项、服务转化、非中庸值 |
| P4 可行动数据 | 行为强度+时间窗口+推荐动作、下一步建议 |
| P5 状态即体验 | 空态教育、加载态掌控感、错误态可执行 |

### 维度四：用户体验符合性（X-01~X-17）

| 框架 | 检查项 |
|------|--------|
| 注意力曲线 S0-S4 | X-01~X-05：各阶段设计要求 |
| 心理变化模型 | X-06~X-09：犹豫→试探→依赖→挑剔 |
| 入门学习曲线 | X-10~X-13：30s/3min/5min/30min |
| Microcopy | X-14~X-17：禁止泛化文案 |

---

## 用例生成指引

> AI 从检查项 + PRD + 设计文档动态生成走查用例，不使用预置用例。

**每个检查项 ≥ 1 个可执行用例**，格式：`PA-维度-编号` | 验证方法 | 执行命令 | 期望结果 | 判定

涉及既有页面改造时，走查用例需同时回答两件事：

1. 设计稿本身是否清晰、有序、可直接对照
2. 代码实现是否忠实还原设计稿

---

## 完成标准（DoD）

- 走查指南已保存至 `docs/acceptance-reports/sprint-N-walkthrough.md`
- 走查报告模板已保存至 `docs/acceptance-reports/sprint-N-acceptance.md`
- Boss 完成走查后，审批记录已保存至 `docs/acceptance-reports/sprint-N-boss-signoff.yml`
- 结论满足：0 Critical + 0 Major + 主张 ≥ 4/5

---

## AI 执行协议

**允许工具**：bash、文件读取、`chrome-devtools`、`webapp-testing` | **禁止**：代码修改、文档修改

**执行步骤**：
1. 前置检查（质量评分 ≥ 95、当前迭代 E2E 通过、P0 回归通过、真实链路通过〔若存在 live 用例〕、PRD/设计存在、环境可访问）
2. 生成走查用例
3. 生成**走查指南**（`docs/acceptance-reports/sprint-N-walkthrough.md`），供 Boss 按步操作
4. 生成**走查报告模板**（`docs/acceptance-reports/sprint-N-acceptance.md`），用于记录 Boss 走查结果
5. Boss 确认后，由编排者执行 `node scripts/acceptance-record.mjs approve|reject <sprint-id>` 固化审批结果

### 走查指南规范

走查指南是面向 Boss 的操作手册，记录操作与预期，不记录执行结果：

| 章节 | 内容 |
|------|------|
| 环境信息 | 测试 URL、账号、版本号 |
| 设计对照 | 设计文档路径 + 原型/设计稿路径 + 核心比对点 |
| 功能走查路径 | 按 PRD 主路径编排的逐步操作指南（含截图） |
| 版式整洁度检查 | 对齐、视觉分组、主次层级、信息密度 |
| 每步包含 | 操作说明 → 预期结果 → 截图占位 |
| 注意事项 | 数据准备、浏览器/设备要求、重试方式 |

涉及头像/图片/上传等媒体能力时，走查指南须覆盖：上传成功 → 跨页回显 → 刷新后持久化。
涉及 `execution.mode: live` 的真实链路时，走查指南须引用最新 live smoke 证据，并明确 Boss 本轮需要复核的真实接口结果。

### 走查报告规范

走查报告用于记录 Boss 的实际结果与结论：

| 章节 | 内容 |
|------|------|
| Boss 走查记录 | 步骤 → 实际结果 → 判定 |
| 偏差清单 | Critical / Major / Minor / Observation |
| 结论 | pass / fail + 摘要 |
| 审批记录 | 关联 `sprint-N-boss-signoff.yml` |

### ⛔ BOSS 产品走查（L3 门控）

Boss 走查阶段的标准动作：

1. 输出走查摘要 + 测试环境 URL + 走查指南路径
2. 使用 `ask_user` 阻塞等待 Boss 明确确认
3. 收到 `通过` / `approved` 后，执行 `node scripts/acceptance-record.mjs approve <sprint-id>`
4. 收到未通过结论后，执行 `node scripts/acceptance-record.mjs reject <sprint-id>` 并回到修复流程
