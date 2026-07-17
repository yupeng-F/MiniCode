// ⚠️ MAI-Harness 框架文件 — 请勿在项目中修改。如需变更请在框架工程中修改并覆盖到此项目。

/**
 * ESLint Configuration — Extends Harness Engineering rules
 *
 * Harness 规则来源：lint/eslint.config.mjs（symlink → mai-harness）
 *
 * 自定义方式：
 * 1. 在下方 overrides 中添加项目特定规则
 * 2. 仅使用基础规则（不含架构检查）：
 *    import { plugin, base } from './lint/eslint.config.mjs';
 *    export default [plugin, base, { ignores: ['dist/'] }];
 */

import harness from './lint/eslint.config.mjs';

export default [
  ...harness,

  // 全局忽略
  {
    ignores: ['dist/', 'build/', 'node_modules/', 'coverage/', '.harness/'],
  },

  // scripts/：CLI 工具，放宽 console 和复杂度限制
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      'complexity': 'off',
      'max-lines-per-function': 'off',
      'max-lines': 'off',
    },
  },

  // 项目特定规则覆盖（按需取消注释）
  // {
  //   files: ['src/**/*.test.ts'],
  //   rules: {
  //     'max-lines-per-function': 'off',
  //   },
  // },
];
