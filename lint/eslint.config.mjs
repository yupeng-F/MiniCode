/**
 * Harness Engineering — ESLint Flat Config（可组合）
 *
 * 将 CODING_BACKEND.md / CODING_FRONTEND.md / PROJECT_RULES.md 中的
 * 硬性约束编码为可机械执行的 ESLint 规则。
 *
 * 使用方式（项目 eslint.config.mjs）：
 *   import harness from './lint/eslint.config.mjs';
 *   export default [...harness, { ignores: ['dist/'] }];
 *
 * 按需组合：
 *   import { plugin, base, architecture } from './lint/eslint.config.mjs';
 *   export default [plugin, base]; // 仅基础规则，跳过架构检查
 */

import harnessPlugin from './harness-plugin.mjs';

// ─── 插件注册（必须包含，放在最前） ──────────────────────────────────────────────

export const plugin = {
  plugins: { harness: harnessPlugin },
};

// ─── H-02: 通用编码约束 ─────────────────────────────────────────────────────────
// 适用于所有 JS/TS 项目，无需特定 parser

export const base = {
  rules: {
    // PROJECT_RULES.md §Key Rules #1: 禁止空 catch 块，至少记录日志
    'no-empty': ['error', { allowEmptyCatch: false }],

    // PROJECT_RULES.md §Key Rules #2: 函数体 ≤ 50 行
    'max-lines-per-function': ['error', {
      max: 50, skipBlankLines: true, skipComments: true,
    }],

    // PROJECT_RULES.md §Key Rules #3: 圈复杂度 ≤ 10
    'complexity': ['error', { max: 10 }],

    // PROJECT_RULES.md §Key Rules #7: 文件 ≤ 300 行
    'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],

    // PROJECT_RULES.md §Key Rules #5: 结构化日志，禁止 console.log
    'no-console': 'error',

    // PROJECT_RULES.md §禁止事项: 禁止 eval / Function() / 动态执行
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',

    // PROJECT_RULES.md §禁止事项: 禁止循环中数据库/API 调用（无法静态检测，但可检测 await-in-loop）
    'no-await-in-loop': 'warn',

    // PROJECT_RULES.md §Key Rules #4: 禁止硬编码密钥
    'harness/no-hardcoded-secrets': 'error',

    // PROJECT_RULES.md §Key Rules #6: 禁止 SQL 拼接
    'harness/no-sql-concatenation': 'error',

    // GOLDEN_RULES.md §G-3: 魔法数字集中管理
    'harness/no-magic-values': ['warn', { ignore: [0, 1, -1, 2, 10, 100, 1000] }],

    // GOLDEN_RULES.md §G-1: 工具函数集中到 shared/
    'harness/no-duplicate-helper': 'warn',

    // CICD.md: 禁止源码直接调用 gh pr / glab mr，统一走 pr-adapter.mjs
    'harness/no-direct-vcs-cli': 'error',
  },
};

// ─── H-01: 分层架构强制执行 ──────────────────────────────────────────────────────
// 适用于模块化后端代码（src/modules/**）

export const architecture = {
  files: ['**/modules/**', '**/src/**'],
  rules: {
    // 强制 Controller → Service → Repository → Types/Config 依赖方向
    'harness/layer-imports': 'error',
  },
};

// ─── 测试文件放宽规则 ────────────────────────────────────────────────────────────
// 测试文件允许更长的函数和文件

export const testOverrides = {
  files: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**'],
  rules: {
    'max-lines-per-function': 'off',
    'max-lines': 'off',
  },
};

// ─── 配置文件豁免 ────────────────────────────────────────────────────────────────

export const configOverrides = {
  files: [
    '**/eslint.config.*', '**/vite.config.*', '**/vitest.config.*',
    '**/tailwind.config.*', '**/postcss.config.*', '**/drizzle.config.*',
    '**/next.config.*', '**/nuxt.config.*',
  ],
  rules: {
    'max-lines-per-function': 'off',
    'max-lines': 'off',
    'no-console': 'off',
  },
};

// ─── 默认导出：全部配置组合 ──────────────────────────────────────────────────────

export default [plugin, base, architecture, testOverrides, configOverrides];
