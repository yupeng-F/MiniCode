#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改。
// =============================================================================
// check-contract-strength.mjs
//
// 校验：lint/ui-contracts.mjs 中每个 contract 的 checks 必须满足最低强度，
// 防止"为让 UI 审计 PASS 而把契约写得过松"的反模式。
//
// 强度规则（每个 contract.checks）：
//   - 至少 1 个 textList（覆盖关键文本/顺序）
//   - 至少 1 个 style（覆盖关键 CSS 计算样式）
//   - 至少 1 个 metric（覆盖布局尺寸/位置）
//   - 至少 1 个 presence 或 count（覆盖结构存在/数量）
//   - 总检查项 ≥ 6
//
// 用法：node scripts/check-contract-strength.mjs --sprint <N-name>
// 退出码：0 = 全部达标，1 = 存在不达标 contract
// =============================================================================

import { err, info, ok, parseArgs } from './lib/utils.mjs';
import { loadContractsStatically } from './lib/ui-contract-helpers.mjs';

const { options } = parseArgs(process.argv.slice(2), { options: ['--sprint'] });
const sprintId = options.get('--sprint');
if (!sprintId) {
  err('--sprint 参数必填');
  process.exit(1);
}

const MIN_TOTAL = 6;

const { required, reason, contracts } = await loadContractsStatically({ sprintId });
if (!required) {
  ok(`UI 审计声明 required=false（${reason || '无理由'}），跳过强度检查`);
  process.exit(0);
}

if (contracts.length === 0) {
  err(`Sprint ${sprintId} 在 lint/ui-contracts.mjs 中未声明任何 contract`);
  process.exit(1);
}

let failures = 0;
for (const contract of contracts) {
  const checks = Array.isArray(contract.checks) ? contract.checks : [];
  const kinds = checks.map((c) => c?.kind).filter(Boolean);
  const counts = kinds.reduce((acc, k) => { acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const has = (k) => (counts[k] || 0) >= 1;
  const structural = has('presence') || has('count');
  const total = checks.length;

  const issues = [];
  if (total < MIN_TOTAL) issues.push(`总检查项 ${total} < ${MIN_TOTAL}`);
  if (!has('textList')) issues.push('缺少 textList（关键文本/顺序）');
  if (!has('style')) issues.push('缺少 style（关键 CSS 样式）');
  if (!has('metric')) issues.push('缺少 metric（布局尺寸/位置）');
  if (!structural) issues.push('缺少 presence 或 count（结构存在/数量）');

  if (issues.length > 0) {
    failures += 1;
    err(`✘ ${contract.name}（${contract.designRef || ''}）`);
    for (const i of issues) console.error(`    - ${i}`);
    console.error(`    分布：${JSON.stringify(counts)}`);
  } else {
    info(`✔ ${contract.name}（共 ${total} 项，分布 ${JSON.stringify(counts)}）`);
  }
}

if (failures > 0) {
  err(`${failures} 个 contract 未达最低强度。请补全 checks，不要降低契约。`);
  process.exit(1);
}

ok(`全部 ${contracts.length} 个 contract 强度达标`);
process.exit(0);
