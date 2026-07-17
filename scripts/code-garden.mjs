#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness code-garden — 代码熵控扫描器
//
// 扫描代码库中的熵增信号，输出模块质量等级，生成技术债条目。
// 卫生指标（TODO/FIXME） + E2E 覆盖 → 质量等级 A-F。
// G-1/G-3 黄金原则由 ESLint harness-plugin.mjs 统一检测。
// 文件行数、函数行数、圈复杂度由 ESLint max-lines / max-lines-per-function /
// complexity 统一检测，code-garden 不再重复扫描（单一真相源）。
//
// 用法: scripts/code-garden.mjs [选项]
//   --src <dir>         源码目录（默认: src/）
//   --ci                CI 模式：F 级模块时退出码 1
//   --report <file>     输出质量报告到文件
//   --help              显示帮助
// =============================================================================

import {
  info, ok, warn, err, fatal,
  parseArgs, findFiles, readText, writeText,
  mdTable, timestamp,
  existsSync,
} from './lib/utils.mjs';

// ─── 帮助 ────────────────────────────────────────────────────────────────────

const HELP = `\
用法: scripts/code-garden.mjs [选项]
  --src <dir>         源码目录（默认: src/）
  --ci                CI 模式：F 级模块时退出码 1
  --report <file>     输出质量报告到文件
  --help              显示帮助

检查项:
  G-1  共享工具库:     由 ESLint harness/no-duplicate-helper 检测
  G-3  魔法数字:       由 ESLint harness/no-magic-values 检测
  文件/函数行数、圈复杂度: 由 ESLint max-lines / max-lines-per-function / complexity 检测
  卫生  TODO/FIXME/HACK 密度
  G-5  E2E 场景覆盖
  质量  模块等级 A-F（基于卫生 + E2E 加权）`;

// ─── 参数解析 ─────────────────────────────────────────────────────────────────

const { flags, options } = parseArgs(process.argv.slice(2), {
  flags: ['--ci'],
  options: ['--src', '--report'],
});

if (flags.has('--help')) {
  console.log(HELP);
  process.exit(0);
}

const SRC_DIR = options.get('--src') ?? 'src';
const CI_MODE = flags.has('--ci');
const REPORT_FILE = options.get('--report') ?? '';

if (!existsSync(SRC_DIR)) {
  fatal(`源码目录不存在: ${SRC_DIR}`);
}

// ─── 源文件匹配 ──────────────────────────────────────────────────────────────

const SRC_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
const SKIP_DIRS = ['node_modules', '.next', 'dist', 'build', '__tests__'];

function findSrcFiles() {
  return findFiles(SRC_DIR, (_fullPath, name) => {
    if (/\.(test|spec)\./.test(name)) return false;
    return SRC_EXT_RE.test(name);
  }, { skipDirs: SKIP_DIRS });
}

// ─── 计数器 ──────────────────────────────────────────────────────────────────

let todoCount = 0;
let e2eMissing = 0;

// ─── G-1/G-3: 委托给 ESLint ──────────────────────────────────────────────────
// G-1 (no-duplicate-helper) 和 G-3 (no-magic-values) 由 ESLint harness-plugin.mjs
// 统一检测（AST 精度更高）。code-garden 不再重复 grep 扫描，避免规则冗余。
// ESLint 通过 pre-commit hook + CI workflow 确定性触发。

function checkLintRules(srcFiles) {
  info('=== G-1/G-3: 由 ESLint harness-plugin.mjs 统一检测 ===');
  ok('G-1 (no-duplicate-helper) + G-3 (no-magic-values) → Lint 前置阻断');
}

// ─── 卫生: TODO/FIXME/HACK ──────────────────────────────────────────────────

function checkHygiene(srcFiles) {
  info('=== 卫生检查: TODO/FIXME/HACK ===');

  const hygieneRe = /TODO|FIXME|HACK|XXX/;
  let count = 0;

  for (const file of srcFiles) {
    const content = readText(file);
    for (const line of content.split('\n')) {
      if (hygieneRe.test(line)) count++;
    }
  }

  todoCount = count;
  if (count === 0) {
    ok('卫生通过: 无遗留 TODO/FIXME/HACK');
  } else if (count <= 5) {
    ok(`卫生: ${count} 个 TODO/FIXME/HACK（可接受）`);
  } else if (count <= 20) {
    warn(`卫生: ${count} 个 TODO/FIXME/HACK（建议清理）`);
  } else {
    warn(`卫生: ${count} 个 TODO/FIXME/HACK（需专项清理）`);
  }
}

// ─── 体积: 委托给 ESLint ─────────────────────────────────────────────────────
// 文件行数 ≤ 300 由 ESLint `max-lines` 规则统一执行（单一真相源）。
// code-garden 不再重复扫描文件行数，避免阈值双点维护。

// ─── G-5: E2E 场景覆盖 ──────────────────────────────────────────────────────

function checkE2E() {
  info('=== G-5: E2E 场景覆盖检查 ===');

  const e2eDir = 'e2e/scenarios';

  if (!existsSync(e2eDir)) {
    warn(`G-5: E2E 场景目录 ${e2eDir}/ 不存在`);
    e2eMissing = 1;
    return;
  }

  const specFiles = findFiles(e2eDir, (_full, name) =>
    /\.spec\.(ts|js)$/.test(name),
  );

  if (specFiles.length === 0) {
    warn(`G-5: ${e2eDir}/ 下无 E2E 场景用例`);
    e2eMissing = 1;
  } else {
    ok(`G-5 通过: ${specFiles.length} 个 E2E 场景文件`);
    e2eMissing = 0;
  }
}

// ─── 质量等级 ────────────────────────────────────────────────────────────────

function computeGrade() {
  let score = 100;

  // TODO: 每 5 处 -5，最多扣 25
  score -= Math.min(Math.floor(todoCount / 5) * 5, 25);

  // G-5: E2E 缺失 -20
  if (e2eMissing) score -= 20;

  let grade;
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'B';
  else if (score >= 70) grade = 'C';
  else if (score >= 60) grade = 'D';
  else grade = 'F';

  return `${grade} (${score}/100)`;
}

// ─── 执行 ────────────────────────────────────────────────────────────────────

console.log();
info('Harness code-garden — 代码熵控扫描');
info(`源码目录: ${SRC_DIR}`);
console.log();

const srcFiles = findSrcFiles();

checkLintRules(srcFiles);
console.log();
checkHygiene(srcFiles);
console.log();
checkE2E();

// ─── 报告 ────────────────────────────────────────────────────────────────────

console.log();
const totalFiles = srcFiles.length;
const grade = computeGrade();
const e2eStatus = e2eMissing === 0 ? '通过' : '缺失';

info('==========================================');
info(`代码质量等级: ${grade}`);
info(`  文件总数:      ${totalFiles}`);
info(`  G-1/G-3:       Lint 统一检测`);
info(`  行数/复杂度:   ESLint 统一检测`);
info(`  G-5 E2E:       ${e2eStatus}`);
info(`  TODO/FIXME:    ${todoCount}`);
info('==========================================');

// 输出报告文件
if (REPORT_FILE) {
  const table = mdTable(
    ['指标', '值'],
    [
      ['质量等级', grade],
      ['文件总数', String(totalFiles)],
      ['G-1/G-3', 'Lint 统一检测'],
      ['行数/复杂度', 'ESLint 统一检测'],
      ['G-5 E2E', e2eStatus],
      ['TODO/FIXME', String(todoCount)],
    ],
  );
  const report = `# Code Garden Report\n\n${table}\n\n生成时间: ${timestamp()}\n`;
  writeText(REPORT_FILE, report);
  ok(`报告已写入: ${REPORT_FILE}`);
}

// CI 模式
if (CI_MODE) {
  const letterGrade = grade.split(' ')[0];
  if (letterGrade === 'F') {
    err('质量等级 F — CI 失败');
    process.exit(1);
  }
}
