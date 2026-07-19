#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Migration Validator (CICD.md / docs/harness/MIGRATION.md)
//
// 用法:
//   migration-check.mjs pair <release-dir>            # 每个 up 必有 down
//   migration-check.mjs name <release-dir>            # 文件名匹配正则
//   migration-check.mjs sign <release-dir>            # 写入 manifest.signature = HEAD sha
//   migration-check.mjs dry-down <release-dir>        # 解析 down.sql，无 syntax error
//   migration-check.mjs idempotency <release-dir>     # PROJECT_TODO：在 test 库重复执行 up
//   migration-check.mjs rehearse <release-dir>        # PROJECT_TODO：完整演练 up→down→up
//   migration-check.mjs all <release-dir>             # pair + name + sign
// =============================================================================

import { info, ok, err, fatal, existsSync, readText, writeText, runCapture, run, join } from './lib/utils.mjs';
import { readdirSync } from 'node:fs';

const NAME_RE = /^\d{3}-[a-z0-9-]+\.(up|down)\.sql$/;

function listSql(dir) {
  if (!existsSync(dir)) fatal(`目录不存在：${dir}`);
  return readdirSync(dir).filter(f => f.endsWith('.sql'));
}

function pair(dir) {
  const ups = new Set(), downs = new Set();
  for (const f of listSql(dir)) {
    const m = f.match(/^(\d{3}-[a-z0-9-]+)\.(up|down)\.sql$/);
    if (!m) continue;
    (m[2] === 'up' ? ups : downs).add(m[1]);
  }
  const missingDown = [...ups].filter(x => !downs.has(x));
  const orphanDown = [...downs].filter(x => !ups.has(x));
  if (missingDown.length || orphanDown.length) {
    if (missingDown.length) err('缺少 down: ' + missingDown.join(', '));
    if (orphanDown.length) err('孤立 down: ' + orphanDown.join(', '));
    process.exit(1);
  }
  ok(`pair 通过（${ups.size} 对）`);
}

function name(dir) {
  const bad = listSql(dir).filter(f => !NAME_RE.test(f));
  if (bad.length) {
    err('命名不规范：' + bad.join(', '));
    err('期望：^\\d{3}-[a-z0-9-]+\\.(up|down)\\.sql$');
    process.exit(1);
  }
  ok('name 通过');
}

function sign(dir) {
  const manifest = join(dir, 'manifest.yml');
  if (!existsSync(manifest)) fatal(`未找到 ${manifest}`);
  const sha = runCapture('git rev-parse HEAD');
  let txt = readText(manifest);
  if (/^signature:.*$/m.test(txt)) {
    txt = txt.replace(/^signature:.*$/m, `signature: "${sha}"`);
  } else {
    txt += `\nsignature: "${sha}"\n`;
  }
  writeText(manifest, txt);
  ok(`signature 已写入：${sha}`);
}

function dryDown(dir) {
  for (const f of listSql(dir).filter(f => f.endsWith('.down.sql'))) {
    const text = readText(join(dir, f));
    // 浅检查：事务包裹（兼容 PG/MySQL/SQLite）。
    // 起始：BEGIN | START TRANSACTION；结束：COMMIT | ROLLBACK（rollback 用于纯校验脚本）。
    const hasBegin = /(^|\s)(BEGIN|START\s+TRANSACTION)\s*;/i.test(text);
    const hasEnd = /(^|\s)(COMMIT|ROLLBACK)\s*;/i.test(text);
    if (!hasBegin || !hasEnd) {
      err(`${f}: 缺少事务包裹 BEGIN/START TRANSACTION ... COMMIT/ROLLBACK（浅检查失败）`);
      process.exit(1);
    }
  }
  ok('dry-down 浅检查通过（深度校验由项目数据库 client 完成 → idempotency / rehearse）');
}

function idempotency(dir) {
  // 委托项目实现：scripts/migration-runner.mjs idempotency <dir>
  const hook = 'scripts/migration-runner.mjs';
  if (!existsSync(hook)) {
    info(`未发现项目 ${hook}：跳过深度幂等校验（建议项目实现）`);
    process.exit(0);
  }
  run(`node ${hook} idempotency ${dir}`);
}

function rehearse(dir) {
  const hook = 'scripts/migration-runner.mjs';
  if (!existsSync(hook)) {
    info(`未发现项目 ${hook}：跳过演练（建议项目实现）`);
    process.exit(0);
  }
  run(`node ${hook} rehearse ${dir}`);
}

function showHelp() {
  console.log(`
Harness Migration Check

  migration-check.mjs pair <release-dir>
  migration-check.mjs name <release-dir>
  migration-check.mjs sign <release-dir>
  migration-check.mjs dry-down <release-dir>
  migration-check.mjs idempotency <release-dir>
  migration-check.mjs rehearse <release-dir>
  migration-check.mjs all <release-dir>

<release-dir> 通常为 deploy/release/<vX.Y.Z>/migrations。详见 docs/harness/MIGRATION.md。
`);
}

const [, , cmd, dir] = process.argv;
if (!cmd || cmd === '--help' || cmd === '-h') { showHelp(); process.exit(0); }
if (!dir) fatal(`<release-dir> 必填`);

switch (cmd) {
  case 'pair': pair(dir); break;
  case 'name': name(dir); break;
  case 'sign': sign(dir); break;
  case 'dry-down': dryDown(dir); break;
  case 'idempotency': idempotency(dir); break;
  case 'rehearse': rehearse(dir); break;
  case 'all': pair(dir); name(dir); dryDown(dir); sign(dir); break;
  default: err(`未知子命令: ${cmd}`); showHelp(); process.exit(1);
}
