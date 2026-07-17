#!/usr/bin/env node
// agents-sync.mjs — 增量同步 AGENTS.md 框架区域
//
// 用法：
//   node scripts/agents-sync.mjs --source <framework AGENTS.md> --target <project AGENTS.md>
//
// 行为：
//   - 提取 source 中 `<!-- harness:framework-map:start -->` 与 `:end -->` 之间的内容
//   - 替换 target 中同名标记块；target 缺少标记块 → 在文件末尾追加
//   - target 不存在 → 直接 cp
//   - source 缺少标记块 → exit 1
//
// 与 install.sh / install.ps1 的协作：
//   首次安装：copy_template 整文件落地（标记块自然存在）
//   重复安装：调本脚本仅刷新框架块，项目自定义内容（项目概述 / TODO / 当前迭代）保留

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';

const START = '<!-- harness:framework-map:start';
const END = '<!-- harness:framework-map:end -->';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

function extractBlock(text, label) {
  const startIdx = text.indexOf(START);
  const endIdx = text.indexOf(END);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    throw new Error(`${label} 缺少 harness:framework-map 标记块`);
  }
  return text.slice(startIdx, endIdx + END.length);
}

const { source, target } = parseArgs(process.argv);
if (!source || !target) {
  console.error('用法: agents-sync.mjs --source <framework> --target <project>');
  process.exit(2);
}

if (!existsSync(target)) {
  copyFileSync(source, target);
  console.log(`[agents-sync] 首次创建：${target}`);
  process.exit(0);
}

const srcBlock = extractBlock(readFileSync(source, 'utf-8'), 'source');
const tgtText = readFileSync(target, 'utf-8');

let next;
if (tgtText.includes(START) && tgtText.includes(END)) {
  next = tgtText.replace(
    new RegExp(`${START}[\\s\\S]*?${END.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`),
    () => srcBlock,
  );
  console.log(`[agents-sync] 框架块已更新：${target}`);
} else {
  next = `${tgtText.trimEnd()}\n\n${srcBlock}\n`;
  console.log(`[agents-sync] 框架块已追加（target 缺少标记块）：${target}`);
}

if (next !== tgtText) writeFileSync(target, next);

const finalText = next;
const finalBlock = extractBlock(finalText, 'target');
if (finalBlock !== srcBlock) {
  console.error(`[agents-sync] 框架块校验失败：${target} 与 ${source} 不一致`);
  process.exit(1);
}
console.log(`[agents-sync] 框架块校验通过：${target}`);
