#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness test-case-backfill — 一次性向后兼容工具
//
// H-OPT v1.6 引入扁平 test-cases/ + introduced_in / last_modified_in /
// last_verified_in 字段。此脚本扫描 test-cases/**/*.yml，对 legacy sprint:
// 用例补齐新字段。
//
// 设计：
//   - 行级追加（不重写 YAML），保留注释与顺序
//   - 幂等：已有三个新字段的文件跳过
//   - DRY-RUN：默认只打印将修改的文件；--write 才落盘
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findFiles, projectRoot, ok, info, warn } from './lib/utils.mjs';

const ROOT = projectRoot(import.meta.url);
const DIR = join(ROOT, 'test-cases');
const WRITE = process.argv.includes('--write');

const files = (() => {
  try { return findFiles(DIR, (full, name) => /\.ya?ml$/.test(name)); }
  catch { return []; }
})();

let modified = 0;
let skipped = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  if (/^introduced_in\s*:/m.test(text) && /^last_modified_in\s*:/m.test(text) && /^last_verified_in\s*:/m.test(text)) {
    skipped++;
    continue;
  }
  const m = text.match(/^(sprint\s*:\s*)([^\n#]+?)(\s*(?:#.*)?)$/m);
  if (!m) {
    warn(`${f}: 无 sprint: 行且新字段不完整，跳过`);
    continue;
  }
  const sprintValue = m[2].trim();
  const additions = [];
  if (!/^introduced_in\s*:/m.test(text)) additions.push(`introduced_in: ${sprintValue}  # backfilled from legacy sprint`);
  if (!/^last_modified_in\s*:/m.test(text)) additions.push(`last_modified_in: ${sprintValue}  # backfilled from legacy sprint`);
  if (!/^last_verified_in\s*:/m.test(text)) additions.push(`last_verified_in: ${sprintValue}  # backfilled from legacy sprint`);
  const newLine = `${m[0]}\n${additions.join('\n')}`;
  const next = text.replace(m[0], newLine);
  if (WRITE) writeFileSync(f, next);
  modified++;
  info(`${WRITE ? 'WRITE' : 'WOULD'}: ${f.replace(ROOT + '/', '')} ← introduced/modified/verified: ${sprintValue}`);
}

ok(`扫描 ${files.length}，将修改 ${modified}，跳过 ${skipped}${WRITE ? '（已写入）' : '（dry-run；加 --write 落盘）'}`);
