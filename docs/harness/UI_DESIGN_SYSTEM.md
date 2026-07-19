# UI Design System

> Harness 框架的统一 UI 设计系统：设计 token + 前端技术栈 + 组件模式。
> 本文档与 [DESIGN.md](DESIGN.md)（设计哲学/流程）、[TECH_FRONTEND.md](TECH_FRONTEND.md)（前端工程方案）配套使用：
> - DESIGN.md = 「为什么这样设计」（哲学、流程、走查）
> - UI_DESIGN_SYSTEM.md = 「具体长什么样」（token、栈、组件）
> - TECH_FRONTEND.md = 「代码怎么实现」（架构、约束）

**目标**：所有基于 Harness 的项目（H5 微站、Dashboard、Admin、Marketing Site）在视觉风格、组件行为、技术栈上保持一致；新项目零思考即可对齐基线。

**产出物**：本文为只读规范。落地资源参见：
- `.harness/framework/templates/ui/tokens.css`（CSS 变量 — HTML 原型 + 应用入口共用）
- `.harness/framework/templates/ui/app.css`（应用 CSS 入口 — Tailwind v4 + tokens）
- `.harness/framework/templates/ui/prototype-base.html`（HTML 原型基础模板）

---

## 1. 前端技术栈基线

> 所有 Harness 项目前端**必须**使用此栈，禁止平行选型。新栈引入须走专项规范更新任务。

| 类别 | 选择 | 版本基线 | 说明 |
|------|------|---------|------|
| 语言 | TypeScript | ≥ 5.9 | strict 模式 |
| 框架 | Vue | ≥ 3.5 | Composition API + `<script setup lang="ts">` |
| 构建 | Vite | ≥ 6 | 禁止 webpack/rollup 直用 |
| 样式 | Tailwind CSS | v4 | `@import 'tailwindcss'` 入口；token 通过 CSS 变量传入 |
| 状态 | Pinia | ≥ 2.3 | `useXxxStore` 命名 |
| 路由 | vue-router | ≥ 4.6 | lazy import + `meta.requiresAuth` |
| 国际化 | vue-i18n | ≥ 9.14 | 默认中英双语，文案禁止硬编码 |
| 单测 | Vitest | ≥ 3.2 | 与 Vite 共享配置 |
| E2E | Playwright | ≥ 1.59 | 共享 `e2e/helpers/` |
| 包管理 | pnpm | ≥ 9 | workspace 单仓多包 |
| Node | Node.js | ≥ 20 | LTS |

**HTML 原型例外**：原型须可直接用浏览器打开，因此使用纯 HTML + 内联 CSS（引用 tokens.css）；禁止依赖构建产物。

---

## 2. 设计 Token

> 所有视觉数值**必须**通过 token 表达，禁止在组件中写魔法数字。token 定义于 `.harness/framework/templates/ui/tokens.css`，作为 CSS 变量暴露；Tailwind v4 通过 `@theme` 引用同名变量。

### 2.1 颜色

| Role | Token | Hex | 用途 |
|------|-------|-----|------|
| **Brand / Primary** | `--color-primary` | `#2563eb` (blue-600) | 主 CTA、链接、品牌色 |
| | `--color-primary-hover` | `#1d4ed8` (blue-700) | hover |
| | `--color-primary-soft` | `#dbeafe` (blue-100) | 选中态背景、tag |
| **Success** | `--color-success` | `#059669` (green-600) | 成功状态、确认操作 |
| | `--color-success-soft` | `#ecfdf5` (green-50) | 成功背景 |
| **Warning** | `--color-warning` | `#d97706` (amber-600) | 提醒、热度指标 |
| | `--color-warning-soft` | `#fff7ed` (amber-50) | 警告背景 |
| **Danger** | `--color-danger` | `#dc2626` (red-600) | 错误、删除 |
| | `--color-danger-soft` | `#fef2f2` (red-50) | 错误背景 |
| **Info** | `--color-info` | `#4338ca` (indigo-700) | 提示、tag |
| | `--color-info-soft` | `#eef2ff` (indigo-50) | tag 背景 |
| **Neutral** | `--color-bg` | `#f3f4f6` (gray-100) | 页面背景 |
| | `--color-surface` | `#ffffff` | 卡片、面板 |
| | `--color-surface-soft` | `#f9fafb` (gray-50) | 表头、次级面板 |
| | `--color-border` | `#e5e7eb` (gray-200) | 边框、分隔 |
| | `--color-border-strong` | `#d1d5db` (gray-300) | 高对比边框 |
| | `--color-text` | `#111827` (gray-900) | 主文本 |
| | `--color-text-secondary` | `#374151` (gray-700) | 次级文本 |
| | `--color-text-muted` | `#6b7280` (gray-500) | 辅助文本 |
| | `--color-text-disabled` | `#9ca3af` (gray-400) | 占位、禁用 |

**禁止**：直接写 hex 值或 Tailwind palette 数值（如 `bg-blue-600`）；必须用语义 token（如 `bg-primary`）或受控的 Tailwind 工具类。
**深色模式**：通过 `[data-theme="dark"]` 覆盖 token；首次落地以浅色为基线，深色 v2 引入。

### 2.2 字体与排版

```
--font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
             "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

| Scale | Size / Line | 用途 |
|-------|-------------|------|
| `--text-xs`   | 12 / 16 | 标签、辅助 |
| `--text-sm`   | 14 / 20 | 正文、按钮 |
| `--text-base` | 16 / 24 | 默认正文（H5） |
| `--text-lg`   | 18 / 28 | 卡片标题 |
| `--text-xl`   | 20 / 28 | 模块标题 |
| `--text-2xl`  | 24 / 32 | 页面副标题 |
| `--text-3xl`  | 30 / 36 | 页面主标题（Dashboard） |
| `--text-4xl`  | 36 / 40 | H5 首屏 hero |

字重：`400` 默认正文 / `500` 按钮与表单 / `600` 卡片标题 / `700` 数据强调与 hero。
**禁止** 使用 ≥ 800 的字重或斜体作为主要排版手段。

### 2.3 间距

8px 基础栅格。

| Token | Px | 用途 |
|-------|----|------|
| `--space-1` | 4   | 图标与文字间距 |
| `--space-2` | 8   | 紧凑组件内 padding |
| `--space-3` | 12  | 控件内 padding |
| `--space-4` | 16  | 卡片内 padding |
| `--space-5` | 20  | 模块间距 |
| `--space-6` | 24  | 面板 padding、模块外距 |
| `--space-8` | 32  | 页面纵向节奏 |
| `--space-12` | 48 | 主区与次区间分割 |

### 2.4 圆角

| Token | Px | 用途 |
|-------|----|------|
| `--radius-sm`   | 4   | tag、徽章 |
| `--radius-md`   | 8   | 按钮、输入框、小卡片 |
| `--radius-lg`   | 12  | 卡片 |
| `--radius-xl`   | 16  | 面板 / 模态 |
| `--radius-2xl`  | 24  | 大面板 / 容器 |
| `--radius-full` | 9999 | 头像、pill、chip |

### 2.5 阴影

| Token | 用途 |
|-------|------|
| `--shadow-sm`  | 卡片悬停、菜单 |
| `--shadow-md`  | 浮层、下拉 |
| `--shadow-lg`  | Toast、Drawer |
| `--shadow-xl`  | 模态 / 弹窗 |

### 2.6 断点

| Token | Px | 设备 |
|-------|----|------|
| `--bp-sm` | 640  | 小型平板纵向 |
| `--bp-md` | 768  | 平板横向 |
| `--bp-lg` | 1024 | 笔记本 |
| `--bp-xl` | 1280 | 桌面（Dashboard 设计基线） |

H5 基线：`375px` 竖屏；Dashboard 基线：`1280px`。Mobile First：默认样式 = mobile，断点向上叠加。

### 2.7 动效

| Token | Duration / Easing | 用途 |
|-------|-------------------|------|
| `--motion-fast`     | 120ms / ease-out          | 进入/离开（hover/tooltip） |
| `--motion-standard` | 200ms / cubic-bezier(.4,0,.2,1) | 状态切换（toast、button loading） |
| `--motion-slow`     | 300ms / cubic-bezier(.4,0,.2,1) | 模态打开、页面切换 |

禁止：> 400ms 的过渡、bouncy/elastic 缓动、纯装饰性动画。

### 2.8 Z-Index

`--z-base 0` → `--z-sticky 10` → `--z-dropdown 100` → `--z-overlay 1000` → `--z-modal 1100` → `--z-toast 1200`。

---

## 3. 布局系统

| 容器 | 最大宽度 | 内边距 |
|------|---------|--------|
| H5 / Viewer | 100vw（375 基线，最大 480） | `--space-4` 横向 |
| Dashboard / Admin | `1280px` 居中 | `--space-6` 横向 |
| 文档/营销 | `1100px` 居中 | `--space-6` 横向 |

栅格：12 列；间距 `--space-6`（24px）。卡片堆叠默认 `gap: --space-6`。

**信息层级**（与 DESIGN.md 一致）：一级=当前任务与状态 / 二级=结果解释与下一步 / 三级=辅助说明。视觉重点 = 业务重点。

---

## 4. 组件模式（Component Patterns）

每个组件**必须**实现以下状态：default / hover / active / focus / loading / disabled / empty / error。

### 4.1 Button

| Variant | 背景 | 文字 | 用途 |
|---------|------|------|------|
| primary   | `--color-primary` → `--color-primary-hover` | 白 | 主 CTA（每屏唯一） |
| secondary | `--color-surface` + border `--color-border-strong` | `--color-text-secondary` | 次操作 |
| danger    | `--color-danger` → red-700 | 白 | 删除/不可逆 |
| ghost     | 透明 | `--color-primary` | 列表内联操作 |
| link      | 透明 | `--color-primary` underline on hover | 文字链接 |

尺寸：sm `h-8 px-3 text-xs` / md `h-10 px-4 text-sm` / lg `h-12 px-6 text-base`。
圆角：`--radius-md`。loading 用 spinner 替换 leading icon，disabled `opacity:.5; cursor:not-allowed`。

### 4.2 Input / Select / Textarea

- 高度 40px，内边距 `--space-3`，边框 `--color-border`，focus 边框 `--color-primary` + 内阴影 2px alpha。
- 标签字号 `--text-sm`，必填 `*` 用 `--color-danger`。
- 行内校验：错误态边框 `--color-danger` + 下方 12px 错误文本。
- placeholder 用 `--color-text-disabled`。

### 4.3 Card / Panel

- 背景 `--color-surface`，边框 `1px solid --color-border`，圆角 `--radius-xl`，padding `--space-5`。
- 标题区 + 操作区一行；title `--text-lg semibold`；副标题 `--color-text-muted text-sm`。
- 卡片间距 `--space-6`。

### 4.4 Modal / Dialog

- 遮罩 `rgba(0,0,0,.4)`，z-index `--z-modal`。
- 容器：宽度 `min(560px, 92vw)`，圆角 `--radius-xl`，padding `--space-6`，阴影 `--shadow-xl`。
- 标题 `--text-lg bold`；正文 `--text-sm` + `leading-relaxed`；操作区右对齐，主操作在右。
- ESC + 点击遮罩可关；危险操作要求二次确认。

### 4.5 Toast

- 浮于顶部居中，`top: 16px`，圆角 `--radius-md`，padding `--space-3 --space-5`，阴影 `--shadow-lg`，z `--z-toast`。
- 颜色：success/error/warning/info 对应 `--color-*`。停留 3-5s。

### 4.6 Tag / Chip / Badge

- pill：`--radius-full`，padding `4px 10px`，`--text-xs font-bold`。
- 配色：用对应 `*-soft` 背景 + 主色文字（如 `--color-primary-soft` + `--color-primary`）。

### 4.7 Table

- 表头 `--color-surface-soft`，文字 `--text-xs uppercase tracking-wide` + `--color-text-disabled`。
- 行：`border-top: 1px solid --color-border`；hover 行 `--color-surface-soft`。
- 单元格 padding `--space-3 --space-4`；数字右对齐。
- 空态：表格内置 illustration + 主标题 + 一句行动指引。

### 4.8 Skeleton（Loading）

- 圆角同对应组件；背景渐变 `linear-gradient(90deg,#e5e7eb,#f3f4f6,#e5e7eb)` 200% 横向流动 1.5s。
- 数据加载 > 200ms 必须用 skeleton；< 200ms 不显示 loading。

### 4.9 Empty / Error / Offline

- Empty：`64-96px` 单色 illustration + 主标题 `--text-lg semibold` + 单句解释 + 单一 CTA。
- Error：红色边框 + 简短错因 + 「重试」按钮（不展示完整堆栈）。
- Offline：顶部黄色 banner（`bg-warning-soft text-warning`）。

### 4.10 Navigation

- Top bar：高度 64px，背景 `--color-surface`，下边框 `--color-border`，sticky。
- Side nav：宽度 240px，desktop only；背景 `--color-surface-soft`；选中项 `--color-primary-soft` + `--color-primary` 文字。
- H5：底部 tab 高 56px，三档；活动态色 `--color-primary`。

---

## 5. 状态完备清单（强制）

> 每个页面交付前必须输出以下**全部 9 项**状态截图/原型。下表 ID 为 `Token 使用清单` 与未来自动校验工具（`scripts/check-state-coverage.mjs`，v2）使用的稳定标识，**禁止**重命名或裁剪。

| ID | 状态 | 必含 |
|----|------|------|
| S1 | 正常态（含真实示例数据） | ✅ |
| S2 | 空态 | ✅ |
| S3 | 加载态（skeleton） | ✅ |
| S4 | 部分加载（局部错误） | ✅ |
| S5 | 错误态（接口失败可重试） | ✅ |
| S6 | 离线/降级态 | ✅ |
| S7 | 权限不足 | ✅ |
| S8 | 移动端 375px | ✅ |
| S9 | 桌面端 1280px（Dashboard 类） | ✅ Dashboard 类必含 / 纯 H5 项目可豁免并在文档说明 |

**单一真相源约定**：
- DESIGN.md / task-rules.yml / 任意走查清单中**禁止**重新枚举状态名；只引用本表 ID。
- 新增/移除状态须更新本节版本（见末尾 §10 规范更新流程）。

---

## 6. 可访问性（A11y）

- 文字与背景对比度 ≥ AA（正文 4.5:1，大字 3:1）。
- 所有交互元素键盘可达；焦点环可见（`outline: 2px solid --color-primary; outline-offset: 2px`）。
- 表单必填提示同时使用颜色 + 文字（不依赖单一颜色）。
- 图片须 `alt`；纯装饰 `alt=""`。
- ARIA：modal 用 `role="dialog" aria-modal="true"`；toast 用 `role="status"`/`role="alert"`。

---

## 7. 国际化与方向

- 所有可见文案通过 `vue-i18n`，禁止硬编码。
- 中英双语作为基线，多语言项目须支持 RTL（`html[dir="rtl"]`）。
- 数字、日期、货币使用 `Intl.*` 本地化；图标方向（箭头）随 `dir` 镜像。

---

## 8. 工程落地

### 8.1 应用入口

`web/src/app.css`：
```css
@import 'tailwindcss';
@import './tokens.css';      /* 由 Harness 安装：.harness/framework/templates/ui/tokens.css */
```

`tailwind.config` 通过 v4 的 `@theme` 块直接引用 CSS 变量，例如 `--color-primary` 自动对应工具类 `bg-primary` / `text-primary`。

### 8.2 HTML 原型

直接复制 `.harness/framework/templates/ui/prototype-base.html`，内联 `tokens.css`，按需添加 section。
所有原型必须：纯 HTML、单文件、无外网依赖（除 Inter 字体可用 system 兜底）、内含 mobile + desktop 两个断点画板。

### 8.3 设计文档（design-docs）

每份设计稿须输出：
1. 页面流（含异常路径）
2. 现状 → 目标对照
3. 状态板（4.x 列出的 9 种状态）
4. token 使用清单（显式列出该页面用到的 tokens / 是否新增）
5. 数据示例清单

新增 token **禁止**直接写在 design 文档中；须先提交「规范更新」任务，扩展 `tokens.css` + 本文档。

---

## 9. 红线

| # | 禁止 | 替代 |
|---|------|------|
| 1 | 直接 hex / RGB | 用 CSS 变量 / 语义 token |
| 2 | 行内魔法数字（margin/padding/font-size） | `--space-*` / `--text-*` |
| 3 | 平行视觉风格（每项目自定义主色/圆角） | 统一 token；如确需差异，扩展 token 而非旁路 |
| 4 | 动效 > 400ms / bouncy 缓动 | `--motion-*` |
| 5 | 文案硬编码 | i18n key |
| 6 | 缺状态（loading/empty/error） | 状态完备清单走查 |
| 7 | 引入新前端框架/状态库 | 走规范更新任务 |
| 8 | 构建依赖原型（HTML 原型必须纯静态） | 内联 CSS/JS |

---

## 10. 与 Harness 流程的关系

- `design` 任务：`task-rules.yml` `specs: [DESIGN.md, UI_DESIGN_SYSTEM.md]`；产出 `docs/design-docs/*` + 原型；token 用量须列明（§8.3）。
- `frontend-design` 任务：`specs: [TECH_FRONTEND.md, UI_DESIGN_SYSTEM.md]`；技术方案必须显式继承本文档第 1 章栈与第 8 章工程落地。
- `code` 任务（前端）：`specs-frontend: [CODING_FRONTEND.md, UI_DESIGN_SYSTEM.md]`；acceptance 包含 `node scripts/ui-tokens-lint.mjs --ci`，机械执行 §9 红线（hex / rgb / 裸 palette / 魔法 px）。
- `code-review` / `product-acceptance`：将 token 使用、状态完备性纳入评分维度（quality-score.mjs Step 6 的 prototype-parity 已隐式覆盖；token-lint 评分维度在 v2 接入）。

**规范更新流程**：本文档（含 §2 token 表 / §5 状态 ID / §1 栈基线）的任何修改需走"规范更新"任务，同时变更 `.harness/framework/templates/ui/tokens.css` 与本文档；变更后 `install.sh` 运行将携带新版本进入下游项目。

