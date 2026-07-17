#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — 产品走查签收与产出物校验
//
// 用法:
//   acceptance-record.mjs lint <sprint-id> [--require-signoff] [--require-approved]
//   acceptance-record.mjs approve <sprint-id> [--by Boss] [--summary "..."]
//   acceptance-record.mjs reject <sprint-id> [--by Boss] [--summary "..."]
// =============================================================================

import {
  C, info, ok, err, fatal,
  parseArgs, readText, writeText, loadYaml, existsSync, join, projectRoot, timestamp, tryRun,
} from './lib/utils.mjs';

const ROOT = projectRoot(import.meta.url);
const REPORT_DIR = join(ROOT, 'docs', 'acceptance-reports');

const { flags, options, positional } = parseArgs(process.argv.slice(2), {
  flags: ['--help', '--require-signoff', '--require-approved'],
  options: ['--by', '--summary', '--commit-sha'],
});

if (flags.has('--help') || positional.length < 2) {
  console.log(`用法:
  acceptance-record.mjs lint <sprint-id> [--require-signoff] [--require-approved]
  acceptance-record.mjs score <sprint-id>     # 按 lint/walkthrough-checks.yml 自动计分
  acceptance-record.mjs approve <sprint-id> [--by Boss] [--summary "..."]
  acceptance-record.mjs reject <sprint-id>  [--by Boss] [--summary "..."]   # 自动触发回退到 code`);
  process.exit(flags.has('--help') ? 0 : 1);
}

const ACTION = positional[0];
const SPRINT_ID = positional[1];
const CONFIRMED_BY = options.get('--by') ?? 'Boss';
const SUMMARY = options.get('--summary') ?? '';
const COMMIT_SHA = options.get('--commit-sha') ?? '';
const SPRINT_SERIES_ID = SPRINT_ID.match(/^sprint-\d+/)?.[0] ?? SPRINT_ID;
const FILE_ID_CANDIDATES = [...new Set([SPRINT_ID, SPRINT_SERIES_ID])];
const SIGNOFF_ID_CANDIDATES = FILE_ID_CANDIDATES;

function resolveExistingPath(suffix, candidates) {
  for (const candidate of candidates) {
    const path = join(REPORT_DIR, `${candidate}${suffix}`);
    if (existsSync(path)) return path;
  }
  return join(REPORT_DIR, `${candidates[0]}${suffix}`);
}

const paths = {
  walkthrough: resolveExistingPath('-walkthrough.md', FILE_ID_CANDIDATES),
  acceptance: resolveExistingPath('-acceptance.md', FILE_ID_CANDIDATES),
  signoff: resolveExistingPath('-boss-signoff.yml', SIGNOFF_ID_CANDIDATES),
};

function fileLabel(path) {
  return path.replace(`${ROOT}/`, '');
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    err(`${label} 不存在: ${fileLabel(path)}`);
    return false;
  }
  ok(`${label} 存在: ${fileLabel(path)}`);
  return true;
}

function lintWalkthrough() {
  if (!assertExists(paths.walkthrough, '走查指南')) return false;
  const text = readText(paths.walkthrough);
  let valid = true;

  const required = ['## 环境信息', '## 设计对照', '## 功能走查路径', '## 版式整洁度检查'];
  for (const marker of required) {
    if (!text.includes(marker)) {
      err(`走查指南缺少章节: ${marker}`);
      valid = false;
    }
  }

  const hasExpected = /预期结果/.test(text);
  if (!hasExpected) {
    err('走查指南缺少“预期结果”字段');
    valid = false;
  }

  if (!/截图占位|\[ \]/.test(text)) {
    err('走查指南缺少截图占位');
    valid = false;
  }

  if (!/docs\/design-docs\/[^\s|)]+\.md/.test(text)) {
    err('走查指南缺少设计文档引用');
    valid = false;
  }

  if (!/docs\/design-docs\/(?:prototypes\/[^\s|)]+|[^\s|)]+\.(html|png))/i.test(text)) {
    err('走查指南缺少原型或设计稿引用');
    valid = false;
  }

  if (!/对齐/.test(text) || !/(留白|分组|密度)/.test(text) || !/(主次|主 CTA|主操作)/.test(text)) {
    err('走查指南缺少版式整洁度检查要点（对齐/分组或密度/主次）');
    valid = false;
  }

  if (/(头像|图片|上传|封面|avatar|image|upload)/i.test(text)) {
    if (!/上传成功/.test(text)) {
      err('媒体走查缺少“上传成功”检查');
      valid = false;
    }
    if (!/(跨页回显|返回.*显示最新|跨页面回显)/.test(text)) {
      err('媒体走查缺少“跨页回显”检查');
      valid = false;
    }
    if (!/(刷新后|重新打开|持久化)/.test(text)) {
      err('媒体走查缺少“刷新后持久化”检查');
      valid = false;
    }
  }

  const forbidden = [
    '实际结果',
    '判定',
    '走查结论',
    '已知偏差',
    '偏差汇总',
    '执行者：harness-review',
    '走查人：harness-review',
  ];
  for (const marker of forbidden) {
    if (text.includes(marker)) {
      err(`走查指南包含结果性内容: ${marker}`);
      valid = false;
    }
  }

  if (valid) ok('走查指南结构通过');
  return valid;
}

function lintAcceptance() {
  if (!assertExists(paths.acceptance, '走查报告')) return false;
  const text = readText(paths.acceptance);
  let valid = true;

  const required = ['## Boss 走查记录', '## 偏差清单', '## 结论'];
  for (const marker of required) {
    if (!text.includes(marker)) {
      err(`走查报告缺少章节: ${marker}`);
      valid = false;
    }
  }

  if (!/实际结果|判定/.test(text)) {
    err('走查报告缺少“实际结果/判定”字段');
    valid = false;
  }

  const severitySections = ['### Critical', '### Major', '### Minor', '### Observation'];
  for (const marker of severitySections) {
    if (!text.includes(marker)) {
      err(`走查报告缺少偏差分级章节: ${marker}`);
      valid = false;
    }
  }

  if (!/boss-signoff\.yml/.test(text)) {
    err('走查报告缺少审批记录路径');
    valid = false;
  }

  const forbidden = [
    '自动化 + 代码审查',
    '走查人：harness-review',
    '执行者：harness-review',
  ];
  for (const marker of forbidden) {
    if (text.includes(marker)) {
      err(`走查报告包含非 Boss 记录内容: ${marker}`);
      valid = false;
    }
  }

  if (valid) ok('走查报告结构通过');
  return valid;
}

function lintSignoff({ requireSignoff, requireApproved }) {
  if (!requireSignoff && !existsSync(paths.signoff)) {
    ok('未要求审批记录');
    return true;
  }
  if (!assertExists(paths.signoff, '审批记录')) return false;

  let record;
  try {
    record = loadYaml(paths.signoff) || {};
  } catch {
    err(`审批记录不可解析: ${fileLabel(paths.signoff)}`);
    return false;
  }

  const requiredKeys = ['sprint', 'decision', 'confirmed_by', 'confirmed_at', 'source'];
  if (requireApproved) requiredKeys.push('commit_sha');
  let valid = true;
  for (const key of requiredKeys) {
    if (!record[key]) {
      err(`审批记录缺少字段: ${key}`);
      valid = false;
    }
  }

  if (requireApproved && record.decision !== 'approved') {
    err(`审批记录未放行: decision=${record.decision || '未填写'}`);
    valid = false;
  }

  if (valid) ok('审批记录结构通过');
  return valid;
}

function runLint() {
  info(`检查 Sprint: ${SPRINT_ID}`);
  const walkthroughOk = lintWalkthrough();
  const acceptanceOk = lintAcceptance();
  const signoffOk = lintSignoff({
    requireSignoff: flags.has('--require-signoff'),
    requireApproved: flags.has('--require-approved'),
  });
  const valid = walkthroughOk && acceptanceOk && signoffOk;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (valid) {
    console.log(`${C.green('PASS')} — 产品走查产出物结构有效`);
    process.exit(0);
  }
  console.log(`${C.red('BLOCKED')} — 产品走查产出物未满足要求`);
  process.exit(1);
}

function writeDecision(decision) {
  if (!assertExists(paths.walkthrough, '走查指南')) process.exit(1);
  if (!assertExists(paths.acceptance, '走查报告')) process.exit(1);

  const signoffPath = join(REPORT_DIR, `${SPRINT_ID}-boss-signoff.yml`);
  const commitSha = COMMIT_SHA || (() => {
    const result = tryRun('git rev-parse HEAD', { cwd: ROOT });
    return result.ok ? result.stdout.trim() : '';
  })();
  if (decision === 'approved' && !commitSha) fatal('无法解析 commit_sha；请传入 --commit-sha <sha> 或在 Git 仓库中执行');
  const content = [
    `sprint: ${SPRINT_ID}`,
    `decision: ${decision}`,
    `confirmed_by: ${CONFIRMED_BY}`,
    `confirmed_at: "${timestamp()}"`,
    commitSha ? `commit_sha: ${commitSha}` : '',
    'source: ask_user',
    `summary: "${SUMMARY.replace(/"/g, '\\"')}"`,
    '',
  ].join('\n');

  writeText(signoffPath, content);
  ok(`审批记录已写入: ${fileLabel(signoffPath)}`);
}

// ─── score: 自动统计偏差 + 产品主张评分 → PASS/FAIL ───────────────────────
// 依据 lint/walkthrough-checks.yml 的 pass_rules + 走查报告偏差清单。

function runScore() {
  if (!assertExists(paths.acceptance, '走查报告')) process.exit(1);
  const checksFile = join(ROOT, 'lint', 'walkthrough-checks.yml');
  if (!existsSync(checksFile)) {
    err(`走查检查清单不存在: ${fileLabel(checksFile)}`);
    process.exit(1);
  }
  let rules;
  try { rules = loadYaml(checksFile)?.pass_rules || {}; }
  catch (e) { err(`walkthrough-checks.yml 解析失败: ${e.message}`); process.exit(1); }

  const text = readText(paths.acceptance);

  // 从偏差清单分级段计数 `- ` 条目。结构约定：
  //   ### Critical
  //   - ...
  //   - ...
  //   ### Major
  //   ...
  function countInSection(label) {
    // [^\n]*\n 保证只吃到 label 所在行末尾，不消耗下一行的 \n，
    // 以便后续 lookahead (?=\n###...) 能定位到下一个小节。
    const re = new RegExp(`###\\s+${label}[^\\n]*\\n([\\s\\S]*?)(?=\\n###\\s+|\\n##\\s+|$)`);
    const m = text.match(re);
    if (!m) return 0;
    const body = m[1];
    if (/^\s*(无|none|n\/a)\s*$/im.test(body)) return 0;
    return (body.match(/^\s*-\s+\S/gm) || []).length;
  }

  const counts = {
    critical: countInSection('Critical'),
    major: countInSection('Major'),
    minor: countInSection('Minor'),
    observation: countInSection('Observation'),
  };

  // 产品主张评分：抓 `P-1..P-5: X/5` 或 `P1..P5: X/5` 的数字
  const stanceScores = [];
  const stanceRe = /P[-]?[1-5]\D+(\d(?:\.\d)?)\s*\/\s*5/g;
  let m;
  while ((m = stanceRe.exec(text)) !== null) {
    const v = parseFloat(m[1]);
    if (!Number.isNaN(v)) stanceScores.push(v);
  }
  const stanceAvg = stanceScores.length
    ? stanceScores.reduce((a, b) => a + b, 0) / stanceScores.length
    : null;

  const cMax = rules.critical_max ?? 0;
  const majMax = rules.major_max ?? 0;
  const minMax = rules.minor_max ?? 5;
  const stanceMin = rules.product_stance_min ?? 4;

  console.log();
  info(`Sprint: ${SPRINT_ID}`);
  info(`偏差统计: Critical=${counts.critical} Major=${counts.major} Minor=${counts.minor} Observation=${counts.observation}`);
  info(`产品主张: ${stanceAvg === null ? '未评分' : `${stanceAvg.toFixed(2)}/5（${stanceScores.length} 条）`}`);

  const fails = [];
  if (counts.critical > cMax) fails.push(`Critical ${counts.critical} > ${cMax}`);
  if (counts.major > majMax) fails.push(`Major ${counts.major} > ${majMax}`);
  if (counts.minor > minMax) fails.push(`Minor ${counts.minor} > ${minMax}`);
  if (stanceAvg === null) fails.push('产品主张未评分（走查报告需含 P-1..P-5: X/5）');
  else if (stanceAvg < stanceMin) fails.push(`产品主张 ${stanceAvg.toFixed(2)} < ${stanceMin}`);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (fails.length === 0) {
    console.log(`${C.green('PASS')} — 走查满足通过标准`);
    process.exit(0);
  }
  for (const f of fails) err(f);
  console.log(`${C.red('FAIL')} — 走查未达标`);
  process.exit(1);
}

if (ACTION === 'lint') {
  runLint();
} else if (ACTION === 'score') {
  runScore();
} else if (ACTION === 'approve') {
  writeDecision('approved');
} else if (ACTION === 'reject') {
  writeDecision('rejected');
  // 自动触发回退：product-acceptance → code
  const planFile = join(ROOT, 'docs', 'exec-plans', 'active', `${SPRINT_ID}.md`);
  if (existsSync(planFile)) {
    info(`触发回退: product-acceptance → code`);
    const { spawnSync } = await import('node:child_process');
    spawnSync('node', [
      join(ROOT, 'scripts', 'task-rollback.mjs'),
      'product-acceptance', 'code', planFile,
      '--reason', SUMMARY || 'Boss 走查驳回',
    ], { stdio: 'inherit' });
  }
} else {
  fatal(`未知动作: ${ACTION}`);
}
