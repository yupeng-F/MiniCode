#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改。
// =============================================================================
// check-prototype-coverage.mjs
//
// 校验：当前 Sprint 的所有 HTML 原型，必须全部在 lint/ui-contracts.mjs 注册。
// 注册判据：某个 contract.prototype.path 指向该 HTML 文件。
//
// 用法：node scripts/check-prototype-coverage.mjs --sprint <N-name>
// 退出码：0 = 全覆盖，1 = 存在未覆盖的原型
// =============================================================================

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { err, info, ok, parseArgs } from './lib/utils.mjs';
import { loadContractsStatically } from './lib/ui-contract-helpers.mjs';

const { options } = parseArgs(process.argv.slice(2), { options: ['--sprint'] });
const sprintId = options.get('--sprint');
if (!sprintId) {
  err('--sprint 参数必填');
  process.exit(1);
}

const PROTOTYPE_ROOT = resolve(process.cwd(), 'docs/design-docs/prototypes');
if (!existsSync(PROTOTYPE_ROOT)) {
  ok('未发现 docs/design-docs/prototypes 目录，跳过 prototype 覆盖检查');
  process.exit(0);
}

const sprintDirName = sprintId.startsWith('sprint-') ? sprintId : `sprint-${sprintId}`;
const sprintProtoDir = join(PROTOTYPE_ROOT, sprintDirName);
if (!existsSync(sprintProtoDir)) {
  // Sprint 没有原型目录 → 也属于"覆盖通过"（无需 UI 契约）
  ok(`Sprint ${sprintId} 无原型目录（${sprintProtoDir}）→ 覆盖检查跳过`);
  process.exit(0);
}

const prototypeFiles = readdirSync(sprintProtoDir)
  .filter((name) => name.endsWith('.html') && name !== 'index.html')
  .map((name) => join('docs/design-docs/prototypes', sprintDirName, name));

if (prototypeFiles.length === 0) {
  ok(`Sprint ${sprintId} 原型目录中无 .html，跳过`);
  process.exit(0);
}

const { required, reason, contracts } = await loadContractsStatically({ sprintId });
if (!required) {
  err(`原型目录存在 ${prototypeFiles.length} 个 HTML，但 lint/ui-contracts.mjs 声明 required=false（${reason || '无理由'}）。请明确登记契约或移除原型。`);
  process.exit(1);
}

const registeredPaths = new Set(
  contracts
    .map((contract) => contract?.prototype?.path)
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/')),
);

const missing = prototypeFiles.filter((p) => !registeredPaths.has(p.replace(/\\/g, '/')));

info(`原型文件总数: ${prototypeFiles.length}, 已登记契约: ${contracts.length}`);
if (missing.length > 0) {
  err(`以下原型未在 lint/ui-contracts.mjs 注册（contract.prototype.path）：`);
  for (const m of missing) console.error(`  - ${m}`);
  err('请为每个原型补充 contract，或将其从 design-docs/prototypes 移除。');
  process.exit(1);
}

ok(`Sprint ${sprintId} 原型 100% 覆盖（${prototypeFiles.length}/${prototypeFiles.length}）`);
process.exit(0);

// silence unused-import warnings for lint/utility tooling parity
void statSync;
