# 前端技术方案规范

> 前端技术方案设计标准。专用于 `frontend-design` 任务类型。
> 编码约束与联调规范见 [CODING_FRONTEND.md](CODING_FRONTEND.md)。
> **统一前端栈、设计 token、组件模式见 [UI_DESIGN_SYSTEM.md](UI_DESIGN_SYSTEM.md)**：技术方案中的栈选型与样式约束以该文档第 1/8 章为唯一真相源，禁止平行选型。

**产出物**：保存至 `docs/tech-docs/`（须更新 `index.md`，关联 User Story ID）

**文档约束**：单份技术方案不超过 **500 行**，**禁止包含代码示例**（用文字、表格、Mermaid 图描述逻辑，代码在编码阶段产生）。超出须按模块拆分。

**渐进式加载**：先读 `docs/tech-docs/index.md`、本次 PRD/设计、UI_DESIGN_SYSTEM 与 ARCHITECTURE，再只打开相关历史技术方案。新方案必须沉淀对旧实现/旧方案的变更、优化、删除，供 Coding 阶段作为唯一历史上下文来源。

---

## 设计约束（硬性）

| 约束 | 指标 |
|------|------|
| 微站生成响应 | P99 < 8s（含 AI 处理） |
| H5 首屏 LCP | < 2s（弱网 3G Lighthouse） |
| Microsite H5 | 单文件可运行，内联关键 CSS，禁止 Vue 运行时 |
| Mobile First | 375px 竖屏基准 |

## 组件设计

### 迭代增强原则（强制）

1. **修改现有优先**：新功能通过扩展现有页面/组件实现
2. **新建须说明理由**：每个新增文件须解释为何现有文件无法承载
3. **修改文件清单**：技术方案必须含所有修改文件路径和说明
4. **禁止平行创建**：禁止创建与现有页面功能重叠的新页面

### 组件规范

- `<script setup lang="ts">`，禁止 Options API
- Props `defineProps<T>()`、Emits `defineEmits<T>()`
- 副作用 `onUnmounted` 清理、文件顺序：script → template → style scoped

## 状态管理

- 局部 `ref/reactive`、跨组件 Pinia store（`useXxxStore`）
- Store 持久化业务数据，不含 UI 状态（loading/error 用本地 ref）

## API / 路由 / 样式

- API 封装在 `services/`，禁止组件直接 fetch，统一错误处理，类型与后端 DTO 同步
- 路由集中 `router/index.ts`，lazy import，`meta.requiresAuth` 鉴权，kebab-case
- Tailwind v4 优先、`:deep()` 穿透、Mobile 优先断点（sm → md）；样式数值**必须**通过 `templates/ui/tokens.css` 暴露的 CSS 变量或 Tailwind 语义类，禁止行内 hex / 魔法数字

## 命名规范

| 场景 | 规范 | 示例 |
|------|------|------|
| 组件 | PascalCase | `MicrositeCard.vue` |
| Composable | `useXxx` | `useMicrositeEditor` |
| Store | `useXxxStore` | `useMicrositeStore` |
| 类型 | PascalCase | `MicrositeDto` |
| 路由页面 | kebab-case 目录 + PascalCase 文件 | `pages/microsite/MicrositeDetail.vue` |

---

## 设计原则

> 技术方案设计和评审时须遵循的经典设计原则。

| 原则 | 说明 | 前端关注点 |
|------|------|-----------|
| **单一职责（SRP）** | 每个组件/composable/函数只承担一个职责 | 组件只管渲染，业务逻辑抽到 composable/store |
| **开闭原则（OCP）** | 对扩展开放，对修改关闭 | 用 Props/Slots/Provide 扩展组件，不改内部实现 |
| **依赖倒置（DIP）** | 依赖抽象不依赖实现 | 组件通过 services/ 调用 API，不直接 fetch |
| **接口隔离（ISP）** | 不强迫使用者依赖不需要的接口 | Props 按需定义，避免传递整个大对象 |
| **里氏替换（LSP）** | 子类型必须能替换基类型 | 组件 Props 接口兼容，替换不破坏父组件 |
| **组合优于继承** | 优先组合/委托复用行为 | Composable 组合 > Mixin 继承，Slot 组合 > 组件继承 |
| **最少知识（LoD）** | 只与直接协作者交互 | 组件不穿透 `store.state.nested.deep` 链式访问 |

---

## 技术方案必须章节

1. **功能概述**：问题 + User Story
2. **组件拆分**：页面组件树 + 职责 → 组件设计
3. **状态设计**：Store 结构 + 本地 vs 全局 → 状态管理
4. **API 接口**：调用后端接口 + 类型定义 → API 规范
5. **路由设计**：新增/变更路由 + 鉴权 → 路由规范
6. **性能设计**：LCP/TTI 影响 + 懒加载 + 骨架屏 → 设计约束
7. **埋点设计**：事件名 + 触发时机 + 参数

---

## AI 执行协议

**允许工具**：文件读写/搜索、explore 子代理、`vue-best-practices`、`chrome-devtools`、`webapp-testing` | **禁止**：bash 执行、代码修改

> **知行合一**：前端开发须在真实浏览器环境中验证交互行为。

**自检清单**：
- 组件全部 Composition API、状态划分正确、API 封装在 services/
- 路由鉴权标注、性能满足约束（LCP < 2s，H5 无 Vue 运行时）
- 命名符合规范、Microsite H5 纯 HTML + 内联 CSS/JS
- 联调验证通过（详见 CODING_FRONTEND.md）
