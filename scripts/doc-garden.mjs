#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness doc-garden — 手动文档园艺
//
// doc-lint 负责硬性结构/链接/索引存在性；doc-garden 负责人工触发的内容健康巡检：
//   1. 文档是否简明（过长章节/过长文件）
//   2. 文案是否专业（AI 套话、占位符）
//   3. 索引是否能概括目录内容（条目数量/摘要缺失）
//   4. 给出可执行整理建议；默认只读，--write-report 落报告。
// =============================================================================

import {
  info, ok, warn, fatal, parseArgs, findFiles,
  existsSync, readText, writeText, readdirSync,
  join, basename,
} from './lib/utils.mjs';

const HELP = `\
用法: scripts/doc-garden.mjs [选项]
  --docs-dir <path>      文档目录（默认: docs）
  --write-report <path>  写入巡检报告（默认只输出到终端）
  --help                 显示帮助

定位：
  doc-lint    = 可机械判定的硬性门禁（断链、必备章节、索引存在性、新鲜度）
  doc-garden  = 用户手动触发的内容治理（简明度、专业度、索引摘要质量、整理建议；不作为 CI 阻断门禁）`;

const { flags, options } = parseArgs(process.argv.slice(2), {
  flags: ['--help'],
  options: ['--docs-dir', '--write-report'],
});

if (flags.has('--help')) {
  console.log(HELP);
  process.exit(0);
}

const DOCS_DIR = options.get('--docs-dir') || 'docs';
const REPORT_PATH = options.get('--write-report') || '';

if (!existsSync(DOCS_DIR)) fatal(`文档目录不存在: ${DOCS_DIR}`);

const issues = [];
const mdFiles = findFiles(DOCS_DIR, (_fp, name) => name.endsWith('.md'), {
  skipDirs: ['node_modules', '.git'],
});

function addIssue(level, file, message) {
  issues.push({ level, file, message });
}

function headingSummary(text) {
  return text.split('\n')
    .filter(line => /^#{1,3}\s+/.test(line))
    .slice(0, 8)
    .map(line => line.replace(/^#+\s+/, '').trim());
}

function checkDocument(file) {
  const text = readText(file);
  const lines = text.split('\n');
  const nonEmpty = lines.filter(line => line.trim()).length;
  const headings = headingSummary(text);

  if (nonEmpty > 500 && /docs\/(product-specs|design-docs|tech-docs)\//.test(file)) {
    addIssue('medium', file, `文档 ${nonEmpty} 行，超过 PRD/设计/技术方案 500 行建议上限，请拆分或压缩`);
  } else if (nonEmpty > 800) {
    addIssue('medium', file, `文档 ${nonEmpty} 行，建议拆分章节或提炼摘要`);
  }

  if (headings.length < 2 && basename(file) !== 'index.md') {
    addIssue('medium', file, '章节过少，难以被索引和渐进式加载准确定位');
  }

  const aiWords = ['赋能', '一站式', '智能化', '全面提升', '极致体验', '无缝衔接'];
  for (const word of aiWords) {
    if (text.includes(word)) addIssue('low', file, `出现泛化/AI 套话「${word}」，建议改为具体用户动作或约束`);
  }

  if (/(TODO|TBD|待补充|占位)/i.test(text)) {
    addIssue('medium', file, '存在 TODO/TBD/占位内容，需确认是否仍有效');
  }
}

function checkIndexes() {
  const indexDirs = [
    'product-specs', 'design-docs', 'tech-docs',
    'review-reports', 'test-reports', 'acceptance-reports',
    'observability-reports', 'bugs',
  ];

  for (const dir of indexDirs) {
    const fullDir = join(DOCS_DIR, dir);
    if (!existsSync(fullDir)) continue;
    const indexFile = join(fullDir, 'index.md');
    if (!existsSync(indexFile)) {
      addIssue('medium', indexFile, '缺少 index.md；doc-lint 硬门禁负责阻塞该问题');
      continue;
    }

    const indexText = readText(indexFile);
    const entries = readdirSync(fullDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md');

    const listedCount = entries.filter(entry => indexText.includes(entry.name)).length;
    if (entries.length > 0 && listedCount === 0) {
      addIssue('medium', indexFile, `目录下有 ${entries.length} 份文档，但索引没有列出文件名`);
    } else if (entries.length > listedCount) {
      addIssue('medium', indexFile, `索引覆盖 ${listedCount}/${entries.length}，建议补齐摘要`);
    }

    if (!/(摘要|模块|状态|verified|stale|draft|最后更新|Owner|适用范围)/i.test(indexText)) {
      addIssue('medium', indexFile, '索引缺少摘要/模块/状态信息，难以支撑渐进式加载');
    }
  }
}

for (const file of mdFiles) checkDocument(file);
checkIndexes();

const high = issues.filter(item => item.level === 'high').length;
const medium = issues.filter(item => item.level === 'medium').length;
const low = issues.filter(item => item.level === 'low').length;

const reportLines = [
  '# Doc Garden Report',
  '',
  `- docs_dir: ${DOCS_DIR}`,
  `- high: ${high}`,
  `- medium: ${medium}`,
  `- low: ${low}`,
  '',
  '## Issues',
  '',
  ...issues.map(item => `- **${item.level}** \`${item.file}\` — ${item.message}`),
  '',
  '## 分工',
  '',
'- `doc-lint.mjs`：CI/评审硬门禁，检查断链、结构、索引存在性、新鲜度。',
'- `doc-garden.mjs`：用户手动触发的内容园艺，检查简明度、专业度、索引摘要质量，并给出整理建议；不以退出码阻断 CI。',
  '',
];

info('Harness doc-garden — 手动文档园艺');
for (const line of reportLines.slice(1)) console.log(line);

if (REPORT_PATH) {
  writeText(REPORT_PATH, reportLines.join('\n'));
  ok(`报告已写入: ${REPORT_PATH}`);
}

if (issues.length === 0) ok('文档园艺检查未发现问题');
else warn(`发现 ${issues.length} 个文档园艺建议（high=${high}, medium=${medium}, low=${low}）`);
