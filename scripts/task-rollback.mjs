#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness rollback — 跨任务统一回退
//
// 质量/走查不达标时，把下游任务状态改回 in-progress 并记录回退原因，
// 让 sprint-gate.mjs 下次前置检查能引导 Agent 重启对应任务。
//
// 调用方:
//   - quality-score.mjs 总分 < 95 → 自动回退 code 任务
//   - acceptance-record.mjs reject → 自动回退 code 任务
//   - 也可用户手动调用
//
// 用法:
//   rollback.mjs <from-task> <to-task> <sprint-plan-file> [--reason "..."]
//
// 示例:
//   rollback.mjs quality code docs/exec-plans/active/sprint-N-<feature>.md --reason "总分 92 < 95"
//
// 退出码: 0 = 回退成功, 1 = 失败
// =============================================================================

import {
  parseArgs, projectRoot,
  C, info, ok,
  existsSync, readText, writeText, timestamp,
} from './lib/utils.mjs';

const ROOT = projectRoot(import.meta.url);
const { flags, options, positional } = parseArgs(process.argv.slice(2), {
  flags: ['--help'],
  options: ['--reason'],
});

if (flags.has('--help') || positional.length < 3) {
  console.log(`用法: rollback.mjs <from-task> <to-task> <sprint-plan-file> [--reason "..."]
  from-task:         触发回退的任务（如 quality / product-acceptance）
  to-task:           被回退的目标任务（如 code）
  sprint-plan-file:  Sprint 计划 Markdown 文件
  --reason:          回退原因（会写入计划文件）`);
  process.exit(flags.has('--help') ? 0 : 1);
}

const [FROM_TASK, TO_TASK, SPRINT_FILE] = positional;
const REASON = options.get('--reason') ?? `${FROM_TASK} 不达标`;

if (!existsSync(SPRINT_FILE)) {
  console.error(`${C.red('✗')} Sprint 计划文件不存在: ${SPRINT_FILE}`);
  process.exit(1);
}

const content = readText(SPRINT_FILE);
const lines = content.split('\n');

// Sprint 计划的任务状态支持两种格式（见 docs/SPRINT.md）：
//   A) 表格行:      | <id> | <type> | ... | <状态> |   — 末列为状态
//   B) 键值对行:    - [-] <task>: ... (status: done)   — 或 `状态：done`
// 命中任一格式即改写为 rollback。

const VALID_STATES = /^(done|completed|通过|完成|in-progress|进行中|pending|待开始|blocked|阻塞|rollback|✅|⏳|⬜|🔄)$/i;
let rolled = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // 格式 A：Markdown 表格行（首列或中间列含 TO_TASK，末列为状态）
  if (/^\s*\|/.test(line) && line.includes(TO_TASK) && /\|[^|]*\|\s*$/.test(line)) {
    const cells = line.split('|');
    // 末列（去首尾空 split 产生的空元素后的最后一个）
    // 结构：['', col1, col2, ..., colN, '']  → 最后非空索引 = cells.length - 2
    const lastIdx = cells.length - 2;
    if (lastIdx >= 1) {
      const current = cells[lastIdx].trim();
      if (current && VALID_STATES.test(current.split(/\s+/)[0])) {
        cells[lastIdx] = ' rollback ';
        lines[i] = cells.join('|');
        rolled++;
        continue;
      }
    }
  }

  // 格式 B：键值对
  const kvRe = new RegExp(
    `^(\\s*[-*#]+.*?\\b${TO_TASK}\\b[^\\n]*?(?:status|状态)\\s*[:：]\\s*)(\\S+)`,
    'i',
  );
  const m = line.match(kvRe);
  if (m) {
    lines[i] = line.replace(kvRe, `$1rollback`);
    rolled++;
  }
}

// 在计划文件末尾追加回退日志
const LOG_HEADER = '## 回退日志';
const entry = `- [${timestamp()}] ${FROM_TASK} → ${TO_TASK}: ${REASON}`;

let out;
if (lines.join('\n').includes(LOG_HEADER)) {
  // 插入到"回退日志"章节末尾
  out = lines.join('\n').replace(
    new RegExp(`(${LOG_HEADER}[^#]*?)(\\n(?=##|\\Z)|$)`, 's'),
    (m, body, tail) => `${body.replace(/\n+$/, '')}\n${entry}\n${tail}`,
  );
} else {
  out = lines.join('\n').replace(/\n*$/, '\n\n') + `${LOG_HEADER}\n\n${entry}\n`;
}

writeText(SPRINT_FILE, out);

if (rolled === 0) {
  info(`未在计划文件中找到 ${TO_TASK} 的 status 行；已追加回退日志，请手工将 ${TO_TASK} 状态改为 rollback。`);
} else {
  ok(`${TO_TASK} 的 ${rolled} 处 status 已标记为 rollback`);
}
ok(`回退日志已写入: ${SPRINT_FILE}`);
console.log();
console.log(`${C.yellow('REMINDER')} 编排者下一轮 Pre-Flight 会识别 rollback 状态并引导重启 ${TO_TASK} 任务。`);
process.exit(0);
