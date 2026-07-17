#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness ui-tokens-lint — UI Token 合规扫描
//
// 把 UI_DESIGN_SYSTEM.md §9 红线机械化：
//   1. 禁止硬编码 hex / RGB 颜色（src/** 内）
//   2. 禁止裸 Tailwind palette 工具类（如 bg-blue-600）→ 必须用语义 token（bg-primary）
//   3. 禁止行内魔法尺寸（margin/padding/gap/font-size/width/height: <数字>px）
//
// 用法:
//   node scripts/ui-tokens-lint.mjs            # 扫描 src/、报告
//   node scripts/ui-tokens-lint.mjs --ci       # 有违规则退出码 1
//   node scripts/ui-tokens-lint.mjs --dir web/src --ci
//
// 豁免（在文件或行级）:
//   /* token-lint-disable */          整文件豁免
//   // token-lint-disable-next-line   下一行豁免
//   行尾注释 token-lint-disable-line  当行豁免
//
// 默认豁免目录: templates/ui, tokens.css 自身, node_modules, dist, build
// =============================================================================

import {
  parseArgs, projectRoot, findFiles, readText,
  C, info, ok, fatal, mdTable,
  existsSync, join, relative,
} from './lib/utils.mjs';

const ROOT = projectRoot(import.meta.url);
const { flags, options } = parseArgs(process.argv.slice(2), {
  flags: ['--ci', '--help'],
  options: ['--dir', '--report'],
});

if (flags.has('--help')) {
  console.log(`用法: scripts/ui-tokens-lint.mjs [--dir <path>] [--ci] [--report <md>]
  --dir <path>   扫描根目录（默认 src/，可多个目录用逗号）
  --ci           违规时退出码 1（默认 0）
  --report <md>  写入 markdown 报告文件
`);
  process.exit(0);
}

const DIRS = (options.get('--dir') ?? 'src,web/src,packages').split(',')
  .map(d => d.trim()).filter(Boolean);
const REPORT = options.get('--report');
const SKIP_DIRS = ['node_modules', 'dist', 'build', '.git', '.next', '.nuxt', 'coverage', 'templates'];
const TARGET_EXT = /\.(vue|css|scss|sass|less|tsx?|jsx?|html|svg\.ts)$/;
const SKIP_FILES = /(tokens\.css|prototype-base\.html)$/;

// ─── 规则 ────────────────────────────────────────────────────────────────────

// 颜色：保留 #fff/#000 (黑白)、#0001..#0009 (alpha)？为求严格，黑白也禁止。但允许 transparent/currentColor 字符串。
// 排除 SVG fill/stroke 短色值在 .svg 文件（已通过扩展名豁免）。
const RX_HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const RX_RGB = /\brgba?\s*\(/g;
const RX_HSL = /\bhsla?\s*\(/g;

// Tailwind palette: 要求使用语义类
const PALETTES = ['slate','gray','zinc','neutral','stone','red','orange','amber','yellow','lime','green','emerald','teal','cyan','sky','blue','indigo','violet','purple','fuchsia','pink','rose'];
const RX_TW_PALETTE = new RegExp(`\\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|placeholder|caret|accent|outline|shadow|decoration)-(?:${PALETTES.join('|')})-\\d{2,3}\\b`, 'g');

// 魔法尺寸: margin/padding/gap/font-size/width/height/top/right/bottom/left: <数字>px
// 允许：0/1px/2px（边框）/var(...) /calc(...) /tokens.css 内
const SIZE_PROPS = ['margin','padding','gap','font-size','width','height','min-width','min-height','max-width','max-height','top','right','bottom','left','line-height','letter-spacing','border-radius'];
const RX_MAGIC_PX = new RegExp(`\\b(?:${SIZE_PROPS.join('|')})(?:-[a-z]+)?\\s*:\\s*([0-9]+)px\\b`, 'gi');
const ALLOWED_PX = new Set([0, 1, 2]);

// 注释剔除（粗略，行级）：
function stripComments(line) {
  return line
    .replace(/\/\/.*$/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

// 字符串字面量保留（颜色仍要查；我们不剥离）
// 但 data: URI、SVG `d=` 路径要忽略：
function isInDataUri(line, idx) {
  return /data:image\//.test(line.slice(Math.max(0, idx - 60), idx));
}

// ─── 扫描 ────────────────────────────────────────────────────────────────────

const violations = []; // {file, line, col, rule, snippet, message}

function pushV(v) { violations.push(v); }

function scanFile(file) {
  const rel = relative(CWD, file);
  if (SKIP_FILES.test(rel)) return;
  const content = readText(file);
  if (/\btoken-lint-disable\b/.test(content) && /^\s*(\/\*|\/\/|<!--)/m.test(content.split('\n').find(l => /token-lint-disable/.test(l)) ?? '')) {
    // file-level disable: a top-level comment containing token-lint-disable
    const top = content.slice(0, 400);
    if (/token-lint-disable/.test(top)) return;
  }

  const lines = content.split('\n');
  let nextDisable = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (nextDisable) { nextDisable = false; continue; }
    if (/token-lint-disable-next-line/.test(raw)) { nextDisable = true; continue; }
    if (/token-lint-disable-line/.test(raw)) continue;

    const code = stripComments(raw);
    if (!code.trim()) continue;

    // R1 hex
    for (const m of code.matchAll(RX_HEX)) {
      if (isInDataUri(raw, m.index)) continue;
      pushV({ file: rel, line: i + 1, col: m.index + 1, rule: 'no-hex-color',
              snippet: m[0], message: `禁止硬编码颜色 ${m[0]}（用 var(--color-*) 或语义类 bg-primary 等）` });
    }
    // R1b rgb/hsl 同样禁止（除非来自 var）
    for (const m of code.matchAll(RX_RGB)) {
      const tail = code.slice(m.index, m.index + 60);
      if (/var\(/.test(tail)) continue;
      pushV({ file: rel, line: i + 1, col: m.index + 1, rule: 'no-rgb-color',
              snippet: tail.split(')')[0] + ')', message: '禁止硬编码 rgb()/rgba()，请用 token 或 color-mix(in srgb, var(--color-*) X%)' });
    }
    for (const m of code.matchAll(RX_HSL)) {
      pushV({ file: rel, line: i + 1, col: m.index + 1, rule: 'no-hsl-color',
              snippet: code.slice(m.index, m.index + 30), message: '禁止硬编码 hsl()/hsla()，请用 token' });
    }

    // R2 tailwind palette
    for (const m of code.matchAll(RX_TW_PALETTE)) {
      pushV({ file: rel, line: i + 1, col: m.index + 1, rule: 'no-raw-tw-palette',
              snippet: m[0], message: `禁止裸 Tailwind palette 工具类 ${m[0]}（请改语义类如 bg-primary / text-muted，或在 @theme 中扩展）` });
    }

    // R3 magic px
    for (const m of code.matchAll(RX_MAGIC_PX)) {
      const px = Number(m[1]);
      if (ALLOWED_PX.has(px)) continue;
      pushV({ file: rel, line: i + 1, col: m.index + 1, rule: 'no-magic-px',
              snippet: m[0], message: `禁止魔法像素 ${m[0]}（用 var(--space-*) / var(--radius-*) / var(--text-*) 等 token）` });
    }
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

const targets = [];
const CWD = process.cwd();
for (const d of DIRS) {
  // 优先 cwd-relative（典型用法是在目标项目根运行），fallback 到框架根
  const cwdAbs = join(CWD, d);
  const rootAbs = join(ROOT, d);
  if (existsSync(cwdAbs)) targets.push(cwdAbs);
  else if (existsSync(rootAbs) && rootAbs !== cwdAbs) targets.push(rootAbs);
}

if (targets.length === 0) {
  info(`扫描目录均不存在（${DIRS.join(', ')}），跳过 ui-tokens-lint`);
  process.exit(0);
}

let scanned = 0;
for (const root of targets) {
  const files = findFiles(root, (full, name) => TARGET_EXT.test(name), { skipDirs: SKIP_DIRS });
  for (const f of files) { scanFile(f); scanned++; }
}

// ─── 输出 ────────────────────────────────────────────────────────────────────

console.log();
info(`UI Token Lint — 扫描 ${scanned} 个文件，发现 ${violations.length} 项违规`);

if (violations.length > 0) {
  // 按规则分组
  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const [rule, list] of byRule) {
    console.log();
    console.log(`${C.red('●')} ${C.bold(rule)} (${list.length})`);
    const head = list.slice(0, 20);
    for (const v of head) {
      console.log(`  ${v.file}:${v.line}:${v.col}  ${C.yellow(v.snippet)}`);
    }
    if (list.length > head.length) console.log(`  ... 还有 ${list.length - head.length} 项`);
  }
  console.log();
  console.log(`参见 docs/UI_DESIGN_SYSTEM.md §9 红线、§2 Token 表`);
}

if (REPORT) {
  const rows = violations.map(v => [v.rule, v.file, v.line, '`' + v.snippet.replace(/\|/g, '\\|') + '`', v.message]);
  const md = [
    `# UI Token Lint Report`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `Files scanned: ${scanned}`,
    `Violations: ${violations.length}`,
    ``,
    rows.length ? mdTable(['rule', 'file', 'line', 'snippet', 'message'], rows) : '✅ No violations',
  ].join('\n');
  const { writeText } = await import('./lib/utils.mjs');
  writeText(REPORT, md);
  info(`报告已写入: ${REPORT}`);
}

if (violations.length === 0) {
  ok('UI Token 合规');
  process.exit(0);
}
if (flags.has('--ci')) process.exit(1);
process.exit(0);
