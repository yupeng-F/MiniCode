#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Export CI Secrets (Legacy)
//
// v1.6+ 运行时 secrets 真源已收敛到 .harness/secrets/<env>.sh。
// 本脚本仅保留为显式废弃入口，避免旧 CI 文档/旧命令继续被误用。
// =============================================================================

import { fatal } from './lib/utils.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('secrets-export.mjs 已废弃：请改用 node scripts/promote-prep.mjs <env> 生成并填写 .harness/secrets/<env>.sh');
  process.exit(0);
}

fatal('secrets-export.mjs 已废弃：运行时 secrets 已迁移到 .harness/secrets/<env>.sh；请改用 node scripts/promote-prep.mjs <env>');
