#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness doc-lint — 文档知识库健康检查
//
// 检查项：
//   1. 内部链接有效性（Markdown 交叉引用）
//   2. 索引完整性（index.md 条目 vs 目录实际文件）
//   3. 结构合规（必须字段/章节检查）
//   4. 新鲜度（git 最后修改超过 N 天 → stale）
//   5. 验证状态字段（H-12: verified/stale/draft 合法性）
//   6. 文档约束（PRD/技术方案行数上限、技术方案禁止代码示例）
//
// 用法: scripts/doc-lint.mjs [选项]
//   --docs-dir <path>   文档目录（默认: docs/）
//   --max-age <days>    新鲜度阈值天数（默认: 30）
//   --fix               自动修复可修复问题（更新 stale 状态）
//   --ci                CI 模式：发现错误时退出码 1
//   --help              显示帮助
// =============================================================================

import {
  C, info, ok, warn, err, fatal,
  runCapture, tryRun, hasCmd,
  readText, writeText, findFiles, parseArgs, loadYaml,
  existsSync, statSync, lstatSync, readdirSync,
  join, dirname, basename, relative,
} from './lib/utils.mjs';
import { readlinkSync, realpathSync } from 'node:fs';
import { HARNESS_PATHS } from '../config/harness-paths.mjs';

// ─── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `\
用法: scripts/doc-lint.mjs [选项]
  --docs-dir <path>   文档目录（默认: docs/）
  --max-age <days>    新鲜度阈值天数（默认: 30）
  --fix               自动修复可修复问题（更新 stale 状态）
  --ci                CI 模式：发现错误时退出码 1
  --help              显示帮助`;

const { flags, options } = parseArgs(process.argv.slice(2), {
  flags: ['--fix', '--ci', '--help'],
  options: ['--docs-dir', '--max-age'],
});

if (flags.has('--help')) {
  console.log(HELP);
  process.exit(0);
}

const DOCS_DIR = options.get('--docs-dir') ?? 'docs';
const MAX_AGE  = parseInt(options.get('--max-age') ?? '30', 10);
const FIX_MODE = flags.has('--fix');
const CI_MODE  = flags.has('--ci');

if (!existsSync(DOCS_DIR)) {
  fatal(`文档目录不存在: ${DOCS_DIR}`);
}

// ─── State ───────────────────────────────────────────────────────────────────

let ERRORS   = 0;
let WARNINGS = 0;

function errMsg(msg)  { err(msg); }
function warnMsg(msg) { warn(msg); }
function okMsg(msg)   { ok(msg); }
function infoMsg(msg) { info(msg); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Collect all .md files under a directory (files and symlinks). */
function findMdFiles(dir, opts = {}) {
  return findFiles(dir, (fp, name) => name.endsWith('.md'), opts);
}

/** Check if path is a symbolic link. */
function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Resolve a symlink to its real path. */
function resolveLink(p) {
  try { return realpathSync(p); } catch { return p; }
}

/** Extract internal markdown links from text. Returns array of link targets. */
function extractInternalLinks(text) {
  const links = [];
  // Match [text](target) — skip http, mailto, anchor-only
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const target = m[1];
    if (/^https?:\/\//.test(target)) continue;
    if (/^mailto:/.test(target)) continue;
    if (target.startsWith('#')) continue;
    links.push(target);
  }
  return links;
}

function internalLinkTargetExists(sourceFile, linkPath) {
  const target = join(dirname(sourceFile), linkPath);
  if (existsSync(target)) return true;

  const rootDocName = linkPath.match(/^\.\.\/(ARCHITECTURE|PROJECT_RULES|USER_STORIES)\.md$/)?.[1];
  if (rootDocName && existsSync(join(HARNESS_PATHS.templates, `${rootDocName}.md`))) {
    return true;
  }

  return false;
}

// ─── 1. Internal link validation ─────────────────────────────────────────────

function checkInternalLinks() {
  infoMsg('=== 检查内部链接 ===');
  let broken = 0;

  const mdFiles = findMdFiles(DOCS_DIR);
  for (const file of mdFiles) {
    let realFile = file;
    if (isSymlink(file)) realFile = resolveLink(file);
    if (!existsSync(realFile)) continue;

    let text;
    try { text = readText(realFile); } catch { continue; }

    const links = extractInternalLinks(text);
    for (const link of links) {
      const linkPath = link.split('#')[0];
      if (!linkPath) continue;
      if (!internalLinkTargetExists(file, linkPath)) {
        errMsg(`断链: ${file} → ${link}`);
        broken++;
      }
    }
  }

  if (broken > 0) {
    ERRORS += broken;
  } else {
    okMsg('所有内部链接有效');
  }
}

// ─── 2. Index completeness ───────────────────────────────────────────────────

function checkIndexCompleteness() {
  infoMsg('=== 检查索引完整性 ===');

  const INDEX_DIRS = [
    'product-specs', 'design-docs', 'tech-docs',
    'review-reports', 'test-reports', 'acceptance-reports',
    'observability-reports', 'bugs',
  ];

  for (const dir of INDEX_DIRS) {
    const fullDir = join(DOCS_DIR, dir);
    if (!existsSync(fullDir)) continue;

    const indexFile = join(fullDir, 'index.md');
    if (!existsSync(indexFile)) {
      errMsg(`缺少索引: ${fullDir}/index.md`);
      ERRORS++;
      continue;
    }

    const indexContent = readText(indexFile);

    // Find .md files (excluding index.md) at depth 1
    let entries;
    try {
      entries = readdirSync(fullDir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name === 'index.md') continue;

      if (!indexContent.includes(entry.name)) {
        warnMsg(`未索引: ${join(fullDir, entry.name)} 不在 ${indexFile} 中`);
        WARNINGS++;
      }
    }
  }

  okMsg('索引完整性检查完成');
}

// ─── 3. Structure compliance ─────────────────────────────────────────────────

function checkStructure() {
  infoMsg('=== 检查文档结构 ===');

  const REQUIRED_SPECS = [
    'harness/SPRINT.md', 'harness/PRODUCT_SENSE.md', 'harness/DESIGN.md',
    'harness/CODING_BACKEND.md', 'harness/CODING_FRONTEND.md',
    'harness/TECH_BACKEND.md', 'harness/TECH_FRONTEND.md',
    'harness/CODE_REVIEW.md', 'harness/QUALITY_SCORE.md',
    'harness/PRODUCT_ACCEPTANCE.md', 'harness/RELEASE.md', 'harness/OBSERVABILITY.md',
    'harness/GOLDEN_RULES.md',
  ];

  for (const spec of REQUIRED_SPECS) {
    const p = join(DOCS_DIR, spec);
    if (!existsSync(p)) {
      errMsg(`缺少规范: ${p}`);
      ERRORS++;
    }
  }

  // Every top-level .md must have an H1 heading in first 5 lines
  let entries;
  try {
    entries = readdirSync(DOCS_DIR, { withFileTypes: true });
  } catch { entries = []; }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = join(DOCS_DIR, entry.name);
    let text;
    try { text = readText(isSymlink(filePath) ? resolveLink(filePath) : filePath); }
    catch { continue; }
    const first5 = text.split('\n').slice(0, 5);
    const hasH1 = first5.some(l => /^# /.test(l));
    if (!hasH1) {
      warnMsg(`缺少一级标题: ${filePath}`);
      WARNINGS++;
    }
  }

  okMsg('结构合规检查完成');
}

// ─── 4. Freshness ────────────────────────────────────────────────────────────

function checkFreshness() {
  infoMsg(`=== 检查新鲜度（阈值: ${MAX_AGE} 天）===`);

  if (!hasCmd('git')) {
    warnMsg('非 Git 仓库或无 git，跳过新鲜度检查');
    return;
  }
  const { ok: isGit } = tryRun('git rev-parse --is-inside-work-tree');
  if (!isGit) {
    warnMsg('非 Git 仓库或无 git，跳过新鲜度检查');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  let staleCount = 0;

  const mdFiles = findMdFiles(DOCS_DIR);
  for (const file of mdFiles) {
    // Skip symlinks (spec files maintained by Harness)
    if (isSymlink(file)) continue;

    const lastMod = runCapture(`git log -1 --format='%at' -- "${file}"`, { ignoreError: true });
    const ts = parseInt(lastMod.replace(/'/g, ''), 10);
    if (!ts || ts === 0) continue;  // Not tracked by git

    const daysAgo = Math.floor((now - ts) / 86400);
    if (daysAgo > MAX_AGE) {
      warnMsg(`陈旧 (${daysAgo}天): ${file}`);
      staleCount++;
      WARNINGS++;
    }
  }

  if (staleCount === 0) {
    okMsg('所有文档在新鲜度阈值内');
  } else {
    warnMsg(`${staleCount} 个文档超过 ${MAX_AGE} 天未更新`);
  }
}

// ─── 5. Verification status field ────────────────────────────────────────────

function checkVerificationStatus() {
  infoMsg('=== 检查验证状态字段 ===');

  const VALID_STATUSES = /^(verified|stale|draft|—)$/;

  const indexFiles = findFiles(DOCS_DIR, (fp, name) => name === 'index.md');
  for (const indexFile of indexFiles) {
    const lines = readText(indexFile).split('\n');

    // Find header row containing 验证状态
    let headerLineIdx = -1;
    let colIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\|.*验证状态.*\|/.test(lines[i])) {
        headerLineIdx = i;
        // Determine column index by splitting on |
        const cols = lines[i].split('|');
        for (let c = 0; c < cols.length; c++) {
          if (/验证状态/.test(cols[c])) { colIndex = c; break; }
        }
        break;
      }
    }
    if (headerLineIdx === -1 || colIndex === -1) continue;

    // Check data rows (skip header + separator row)
    for (let i = headerLineIdx + 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('|')) continue;
      if (line.includes('_(待')) continue;

      const cols = line.split('|');
      if (colIndex >= cols.length) continue;
      const status = cols[colIndex].trim();
      if (!status) continue;

      if (!VALID_STATUSES.test(status)) {
        warnMsg(`非法状态值 '${status}' in ${indexFile}（应为 verified/stale/draft）`);
        WARNINGS++;
      }
    }
  }

  okMsg('验证状态字段检查完成');
}

// ─── 6. Doc constraints ──────────────────────────────────────────────────────

const MAX_DOC_LINES = 500;

function checkDocConstraints() {
  infoMsg(`=== 检查文档约束（≤ ${MAX_DOC_LINES} 行，技术方案禁止代码示例）===`);

  // 6a. PRD line count
  const prdDir = join(DOCS_DIR, 'product-specs');
  if (existsSync(prdDir)) {
    let entries;
    try { entries = readdirSync(prdDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'index.md') continue;
      const filePath = join(prdDir, entry.name);
      const lineCount = readText(filePath).split('\n').length;
      if (lineCount > MAX_DOC_LINES) {
        errMsg(`PRD 超限: ${filePath}（${lineCount} 行，上限 ${MAX_DOC_LINES}）— 须拆分为多份 PRD`);
        ERRORS++;
      }
    }
  }

  // 6b. Tech doc line count + code block check
  const techDir = join(DOCS_DIR, 'tech-docs');
  if (existsSync(techDir)) {
    let entries;
    try { entries = readdirSync(techDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'index.md') continue;
      const filePath = join(techDir, entry.name);
      const text = readText(filePath);
      const lines = text.split('\n');

      if (lines.length > MAX_DOC_LINES) {
        errMsg(`技术方案超限: ${filePath}（${lines.length} 行，上限 ${MAX_DOC_LINES}）— 须按模块拆分`);
        ERRORS++;
      }

      // Detect fenced code blocks (```) excluding mermaid/markdown/text/empty
      const codeBlockMatches = [];
      for (let i = 0; i < lines.length; i++) {
        if (/^```/.test(lines[i]) && !/^```(mermaid|markdown|text|)$/i.test(lines[i])) {
          codeBlockMatches.push(`${i + 1}:${lines[i]}`);
        }
      }
      if (codeBlockMatches.length > 0) {
        errMsg(`技术方案含代码示例: ${filePath} — 禁止包含代码块，用文字/表格/Mermaid 描述`);
        for (const match of codeBlockMatches.slice(0, 5)) {
          errMsg(`  行 ${match}`);
        }
        ERRORS++;
      }
    }
  }

  okMsg('文档约束检查完成');
}

// ─── 7. Required sections (from task-rules.yml: doc_section_rules) ──────────

function checkRequiredSections() {
  const rulesFile = join('lint', 'task-rules.yml');
  if (!existsSync(rulesFile)) return;

  let rules;
  try {
    rules = loadYaml(rulesFile)?.doc_section_rules;
  } catch { return; }
  if (!rules || typeof rules !== 'object') return;

  infoMsg(`=== 检查必填章节（来源: ${rulesFile} doc_section_rules）===`);

  for (const [dir, patterns] of Object.entries(rules)) {
    if (!existsSync(dir) || !Array.isArray(patterns)) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'index.md') continue;
      const filePath = join(dir, entry.name);
      const text = readText(filePath);
      const lines = text.split('\n');
      for (const pattern of patterns) {
        let re;
        try { re = new RegExp(pattern, 'm'); } catch { continue; }
        const hit = lines.some(line => re.test(line));
        if (!hit) {
          errMsg(`${filePath}: 缺少必填章节匹配 /${pattern}/`);
          ERRORS++;
        }
      }
    }
  }
  okMsg('必填章节检查完成');
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log();
infoMsg('Harness doc-lint — 文档知识库健康检查');
infoMsg(`文档目录: ${DOCS_DIR}`);
console.log();

checkInternalLinks();
console.log();
checkIndexCompleteness();
console.log();
checkStructure();
console.log();
checkFreshness();
console.log();
checkVerificationStatus();
console.log();
checkDocConstraints();
console.log();
checkRequiredSections();

// ─── Report ──────────────────────────────────────────────────────────────────

console.log();
infoMsg('==========================================');
if (ERRORS > 0) {
  errMsg(`发现 ${ERRORS} 个错误, ${WARNINGS} 个警告`);
  if (CI_MODE) process.exit(1);
} else if (WARNINGS > 0) {
  warnMsg(`0 个错误, ${WARNINGS} 个警告`);
} else {
  okMsg('文档知识库健康 ✓（0 错误, 0 警告）');
}
infoMsg('==========================================');
