#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Sprint 前置条件校验 (task-rules.yml 执行引擎)
//
// 在任务开始前校验：前置条件 / 门控审批 / 上游产出物
// Agent 在 Step 0 PRE-FLIGHT 时必须调用此脚本。
//
// 用法:
//   sprint-gate.mjs <task-type> <sprint-plan-file> [--strict]
//
// 示例:
//   sprint-gate.mjs code docs/exec-plans/active/sprint-N-<feature>.md
//   sprint-gate.mjs product-acceptance docs/exec-plans/active/sprint-N-<feature>.md --strict
//
// 退出码: 0 = PASS, 1 = BLOCKED
// =============================================================================

import {
  parseArgs, loadYaml, projectRoot, findFiles,
  info, ok, warn, err, C,
  existsSync, readText, writeText, mkdirSync, join, basename, tryRun,
} from './lib/utils.mjs';
import { readdirSync, statSync } from 'node:fs';

// ─── 参数解析 ────────────────────────────────────────────────────────────────

const ROOT = projectRoot(import.meta.url);
const { flags, options, positional } = parseArgs(process.argv.slice(2), {
  flags: ['--strict', '--reset-retry', '--increment-retry'],
  options: ['--task-id', '--max-retry', '--preflight-ttl'],
});

const HELP_TEXT = `用法: sprint-gate.mjs <task-type> <sprint-plan-file> [options]
  task-type:           任务类型（task-rules.yml 中已注册，含 CICD.md 新类型）
  sprint-plan-file:    Sprint 计划文件路径
  --strict:            严格模式（产出物文件、审批记录、结构检查全部启用）
  --task-id <id>:      任务唯一标识（用于重试计数；默认 <task-type>）
  --max-retry <N>:     最大失败重试次数，默认 3
  --increment-retry:   将重试计数 +1（编排者在 REVIEW FAIL → 回 PLAN 时调用）
  --reset-retry:       重置当前任务重试计数器（写入审计日志）
  --preflight-ttl <s>: preflight 缓存 TTL，默认读 task-rules.yml.sprint_preflight.ttl_seconds（fallback 600）
                       注意：preflight 始终自动调用，无跳过开关`;

if (flags.has('--help')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (positional.length < 2) {
  console.log(HELP_TEXT);
  process.exit(1);
}

const TASK_TYPE = positional[0];
const SPRINT_FILE = positional[1];
const STRICT = flags.has('--strict');

let blocked = false;
const reasons = [];

function pass(msg) { console.log(`${C.green('✅')} ${msg}`); }
function fail(msg) { console.log(`${C.red('❌')} ${msg}`); blocked = true; reasons.push(msg); }

// ─── 定位 task-rules.yml ─────────────────────────────────────────────────────

const RULES_FILE = join(ROOT, 'lint', 'task-rules.yml');
if (!existsSync(RULES_FILE)) {
  fail(`task-rules.yml 不存在: ${RULES_FILE}`);
  console.log('\nBLOCKED');
  process.exit(1);
}

// Schema 校验：task-rules.yml 结构错误时直接 BLOCK，避免下游字段漂移后才报错
{
  const VALIDATOR = join(ROOT, 'scripts', 'validate-task-rules.mjs');
  if (!existsSync(VALIDATOR)) {
    fail(`validate-task-rules.mjs 不存在: ${VALIDATOR} — Harness 框架未正确同步到本项目`);
    console.log('\nBLOCKED');
    process.exit(1);
  }
  const { ok: rulesOk, stdout, stderr } = tryRun(`node ${VALIDATOR} --file ${RULES_FILE}`, { cwd: ROOT });
  if (!rulesOk) {
    fail(`task-rules.yml 结构校验失败`);
    if (stdout) info(stdout.trim().slice(0, 600));
    if (stderr) info(stderr.trim().slice(0, 600));
    console.log('\nBLOCKED');
    process.exit(1);
  }
}

if (!existsSync(SPRINT_FILE)) {
  fail(`Sprint 计划文件不存在: ${SPRINT_FILE}`);
  console.log('\nBLOCKED');
  process.exit(1);
}

// ─── 解析 task-rules.yml ─────────────────────────────────────────────────────

const rules = loadYaml(RULES_FILE);
const taskDef = rules.tasks?.[TASK_TYPE];

if (!taskDef) {
  fail(`task-rules.yml 中未找到任务类型: ${TASK_TYPE}`);
  console.log('\nBLOCKED');
  process.exit(1);
}

info(`任务类型: ${TASK_TYPE}`);
info(`Sprint 文件: ${SPRINT_FILE}`);
console.log('');

const sprintContent = readText(SPRINT_FILE);
const sprintId = basename(SPRINT_FILE).replace(/\.md$/, '');
const sprintSeriesId = sprintId.match(/^sprint-\d+/)?.[0] ?? sprintId;
let harnessConfig = null;
let harnessConfigLoadError = null;

// ─── 重试计数器（避免无限循环触发同一任务） ─────────────────────────────────
// 语义：
//   --reset-retry      → 计数清零，写入审计日志
//   --increment-retry  → 计数 +1（编排者在 REVIEW FAIL → 回 PLAN 时调用）
//   默认调用            → 只读取并校验，不改写
const RETRY_DIR = join(ROOT, '.harness', 'retry');
const taskId = options.get('--task-id') || TASK_TYPE;
const retryCounterFile = join(RETRY_DIR, `${sprintId}-${taskId}.count`);
const retryAuditFile = join(RETRY_DIR, `${sprintId}-${taskId}.audit.log`);
const maxRetry = parseInt(options.get('--max-retry') || '3', 10);

function readRetryCount() {
  if (!existsSync(retryCounterFile)) return 0;
  return parseInt(readText(retryCounterFile).trim() || '0', 10) || 0;
}
function writeRetryCount(n) {
  try { mkdirSync(RETRY_DIR, { recursive: true }); writeText(retryCounterFile, `${n}\n`); }
  catch { /* ignore filesystem race */ }
}
function appendAudit(line) {
  try {
    mkdirSync(RETRY_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const existing = existsSync(retryAuditFile) ? readText(retryAuditFile) : '';
    writeText(retryAuditFile, `${existing}${ts} ${line}\n`);
  } catch { /* ignore filesystem race */ }
}

if (flags.has('--reset-retry')) {
  const before = readRetryCount();
  writeRetryCount(0);
  appendAudit(`RESET (was ${before})`);
  pass(`重试计数器已重置: ${sprintId}-${taskId}（原值 ${before}）`);
} else if (flags.has('--increment-retry')) {
  const next = readRetryCount() + 1;
  writeRetryCount(next);
  appendAudit(`INCREMENT → ${next}`);
  if (next > maxRetry) {
    fail(`任务 ${sprintId}-${taskId} 已重试 ${next} 次（> ${maxRetry}）— 必须人工介入或 --reset-retry`);
  } else {
    pass(`重试计数 +1: ${next}/${maxRetry}（${sprintId}-${taskId}）`);
  }
} else {
  const currentCount = readRetryCount();
  if (currentCount > maxRetry) {
    fail(`任务 ${sprintId}-${taskId} 已重试 ${currentCount} 次（> ${maxRetry}）— 必须人工介入或 --reset-retry`);
  } else {
    pass(`重试计数: ${currentCount}/${maxRetry}（${sprintId}-${taskId}）`);
  }
}

// ─── 自动调用 verify.mjs preflight（带 TTL 缓存避免重复执行；无跳过开关） ──
{
  const verifyScript = join(ROOT, 'scripts', 'verify.mjs');
  if (existsSync(verifyScript)) {
    const ymlTtl = rules.sprint_preflight?.ttl_seconds;
    const ttl = options.get('--preflight-ttl') || (ymlTtl != null ? String(ymlTtl) : '600');
    const cmd = `node "${verifyScript}" preflight --skip-if-recent ${ttl}`;
    const { ok: isOk, stdout } = tryRun(cmd, { cwd: ROOT });
    if (isOk) {
      pass(`Preflight 检查通过（${ttl}s TTL）`);
    } else {
      fail(`Preflight 检查未通过 — 运行 ${cmd} 查看详情`);
      if (stdout) info(stdout.trim().slice(0, 4000));
    }
  } else {
    fail(`未找到 ${verifyScript} — Harness 框架未正确同步到本项目`);
  }
}

// ─── 检查 0.5: 任务级 infra_ready（task-rules.yml 中按任务声明的入口检查命令） ──
// 与全局 verify.mjs preflight 互补：preflight 是项目通用环境，infra_ready 是单个任务
// 的特化入口检查（如 prod-deploy 检查 prod 环境、release 检查 test 环境锁）。
// 复执行抑制：每个 (task-type, command) TTL 内成功过则跳过。
{
  const infraCmd = taskDef.infra_ready;
  if (!infraCmd) {
    pass('无 infra_ready 入口检查（任务未声明）');
  } else if (/scripts\/verify\.mjs\s+preflight/.test(infraCmd) && !/&&|\|\|/.test(infraCmd)) {
    // 与上方全局 preflight 完全等价 → 已执行过，避免重复
    pass(`infra_ready 与全局 preflight 同命令，已在前一步执行: ${infraCmd}`);
  } else {
    const cacheKey = `${TASK_TYPE}::${infraCmd}`;
    const cacheFile = join(ROOT, '.harness', 'infra-ready-cache.json');
    const ttlSec = Number(options.get('--preflight-ttl') || rules.sprint_preflight?.ttl_seconds || 600);
    let cache = {};
    if (existsSync(cacheFile)) {
      try { cache = JSON.parse(readText(cacheFile)); } catch { cache = {}; }
    }
    const last = cache[cacheKey];
    const now = Math.floor(Date.now() / 1000);
    if (last && (now - last) < ttlSec) {
      pass(`infra_ready 已在 ${now - last}s 前通过（TTL ${ttlSec}s 内复用）: ${infraCmd}`);
    } else {
      const { ok: isOk, stdout, stderr } = tryRun(infraCmd, { cwd: ROOT });
      if (isOk) {
        pass(`infra_ready 通过: ${infraCmd}`);
        cache[cacheKey] = now;
        try { mkdirSync(join(ROOT, '.harness'), { recursive: true }); } catch { /* 缓存目录创建失败不影响主流程 */ }
        try { writeText(cacheFile, JSON.stringify(cache, null, 2)); } catch { /* 缓存写入失败不影响主流程 */ }
      } else {
        fail(`infra_ready 未通过: ${infraCmd}`);
        const tail = (stdout || stderr || '').trim().slice(-2000);
        if (tail) info(tail);
      }
    }
  }
}

console.log('');

function fillSprintPattern(text) {
  if (!text) return text;
  return text
    .replace(/sprint-N-name/g, sprintId)
    .replace(/sprint-N/g, sprintSeriesId)
    .replace(/<N-name>/g, sprintId);
}

// ─── 检查 1: 前置条件 (prerequisites) ────────────────────────────────────────

info('--- 检查前置条件 ---');

const prereqs = taskDef.prerequisites || [];
const prereqAnyGroups = taskDef.prerequisites_any || [];
const DONE_RE = /^(done|完成|通过)$/i;
const ROLLBACK_RE = /^(rollback|回退)$/i;
// 按长度倒序，避免 'design' 误命中 'backend-design'/'frontend-design'
const TASK_KEYWORDS = [
  // 长串优先：避免短串误命中
  'product-acceptance', 'backend-design', 'frontend-design', 'sprint-close',
  'test-case-gen', 'release-approval', 'release-prep', 'migration-design',
  'promote-prep', 'build-image', 'promote-test', 'hotfix-init',
  'back-merge', 'prod-deploy',
  'observe', 'quality', 'integration', 'regression',
  'design', 'product', 'infra', 'code', 'pr',
];

function splitMarkdownRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function parseStructuredTaskStatus(text) {
  const statuses = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const headers = splitMarkdownRow(lines[i]);
    const typeIdx = headers.findIndex(h => /^(类型|type)$/i.test(h));
    const statusIdx = headers.findIndex(h => /^(状态|status)$/i.test(h));
    const idIdx = headers.findIndex(h => /^(ID|id|任务ID|task id)$/i.test(h));
    if (typeIdx < 0 || statusIdx < 0) continue;
    const separator = splitMarkdownRow(lines[i + 1] || '');
    if (!isSeparatorRow(separator)) continue;
    for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const cells = splitMarkdownRow(lines[j]);
      if (cells.length <= Math.max(typeIdx, statusIdx)) continue;
      const type = cells[typeIdx];
      const status = cells[statusIdx];
      const id = idIdx >= 0 ? cells[idIdx] : '';
      if (!type || !status) continue;
      if (!statuses.has(type)) statuses.set(type, []);
      statuses.get(type).push(status);
      if (id) statuses.set(id, [status]);
    }
  }
  return statuses;
}

const STRUCTURED_STATUSES = parseStructuredTaskStatus(sprintContent);

function extractTaskKeyword(text) {
  return TASK_KEYWORDS.find(k => String(text || '').includes(k)) || '';
}

function chooseRepresentativeStatus(statuses) {
  if (!statuses || statuses.length === 0) return '';
  if (statuses.length > 1) {
    fail(`任务状态不唯一：${statuses.join(', ')}。请在 Sprint 任务表使用唯一 task id 或清理历史重复行。`);
    return statuses[statuses.length - 1];
  }
  return statuses[0];
}

function findTaskStatus(taskKeyword) {
  const structured = chooseRepresentativeStatus(STRUCTURED_STATUSES.get(taskKeyword));
  if (structured) return structured;
  const statusRegex = new RegExp(taskKeyword, 'i');
  const matchingLines = sprintContent.split('\n').filter(l => statusRegex.test(l));
  const statusMatches = matchingLines
    .map(l => l.match(/\b(done|完成|通过|in-progress|pending|blocked|rollback|回退)\b/i))
    .filter(Boolean);
  const statusMatch = statusMatches[statusMatches.length - 1];
  return statusMatch?.[1] || '';
}

if (prereqs.length === 0) {
  pass('无前置条件');
} else {
  for (const prereq of prereqs) {
    if (!prereq) continue;

    const keywordMatch = extractTaskKeyword(prereq);

    if (keywordMatch) {
      const taskStatus = findTaskStatus(keywordMatch);

      if (DONE_RE.test(taskStatus)) {
        pass(`前置条件满足: ${prereq} (状态: ${taskStatus})`);
      } else if (ROLLBACK_RE.test(taskStatus)) {
        fail(`前置条件未满足: ${prereq} 处于 rollback 状态，请先重做该任务并更新状态为 done`);
      } else {
        fail(`前置条件未满足: ${prereq} (状态: ${taskStatus || '未找到'})`);
      }
    } else {
      // Cannot auto-parse — check for file reference (e.g. "USER_STORIES.md 中有对应 Story")
      const fileRefMatch = prereq.match(/[A-Z_]+\.md/);
      if (fileRefMatch) {
        const fileName = fileRefMatch[0];
        const found = findFiles(ROOT, (_fp, name) => name === fileName, { maxDepth: 3 });
        if (found.length > 0) {
          pass(`前置文件存在: ${fileName}`);
        } else {
          fail(`前置文件不存在: ${fileName} (${prereq})`);
        }
      } else {
        warn(`前置条件需人工确认: ${prereq}`);
      }
    }
  }
}

const satisfiedAnyPrereqs = [];
for (const [idx, group] of prereqAnyGroups.entries()) {
  const matched = group
    .map(keyword => ({ keyword, status: findTaskStatus(keyword) }))
    .filter(item => DONE_RE.test(item.status));
  if (matched.length > 0) {
    satisfiedAnyPrereqs.push(matched[0].keyword);
    pass(`任一前置条件组 #${idx + 1} 满足: ${matched[0].keyword} (${matched[0].status})`);
  } else {
    const observed = group.map(keyword => `${keyword}:${findTaskStatus(keyword) || '未找到'}`).join(', ');
    fail(`任一前置条件组 #${idx + 1} 未满足（需满足其中一个）：${observed}`);
  }
}

console.log('');

// ─── 检查 2: 门控级别 (gate) ─────────────────────────────────────────────────

info('--- 检查门控级别 ---');

const gate = taskDef.gate;

if (!gate) {
  warn('未找到门控级别定义');
} else {
  info(`门控级别: ${gate}`);

  if (gate === 'L3') {
    // L3 = 必须审批。检查 Sprint 文件中是否有审批记录
    const l3Approved = sprintContent.split('\n').find(l =>
      /approved|通过|✅.*(走查|审批|确认)/i.test(l),
    );

    if (l3Approved) {
      pass('L3 门控: 找到审批记录');
    } else {
      const blockingNote = taskDef.blocking;
      if (blockingNote) {
        info(`当前任务是 L3 阻断点: 完成后需等待用户审批才能继续下游任务`);
      }
      pass('L3 门控: 当前任务为 L3 级别（完成后需审批）');
    }
  } else {
    pass(`门控级别 ${gate}: 无阻断要求`);
  }
}

console.log('');

// ─── 检查 3: 上游产出物 (outputs) ────────────────────────────────────────────

info('--- 检查上游产出物 ---');

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function upstreamFromTaskRules(taskType) {
  const fromPrereqs = prereqs.map(extractTaskKeyword).filter(Boolean);
  const fromAny = satisfiedAnyPrereqs;
  const fromSpawn = [];
  for (const rule of rules.spawn_rules || []) {
    if (!toArray(rule.to).includes(taskType)) continue;
    for (const candidate of toArray(rule.from)) {
      // spawn_rules 是流程图，不是实际执行记录；只把已完成的上游纳入产出物检查，
      // 避免条件分支（如 backend-design/frontend-design 二选一）在 strict 模式误阻断。
      if (DONE_RE.test(findTaskStatus(candidate))) fromSpawn.push(candidate);
    }
  }
  return [...new Set([...fromPrereqs, ...fromAny, ...fromSpawn])];
}

const upstreamTasks = upstreamFromTaskRules(TASK_TYPE);

if (upstreamTasks.length === 0) {
  pass('无上游产出物依赖');
} else {
  for (const upstream of upstreamTasks) {
    const upstreamDef = rules.tasks?.[upstream];
    const outputPath = upstreamDef?.outputs?.path || '';

    // Skip non-file output paths
    if (!outputPath || /项目根目录|PR URL|部署产物/.test(outputPath)) {
      pass(`上游 ${upstream}: 产出物路径为非文件类型，跳过文件检查`);
      continue;
    }

    // Handle compound paths like "src/ 或 web/src/ 或 e2e/scenarios/"
    // Just take the first concrete path
    const firstPath = outputPath.split(/\s*或\s*/)[0].trim();
    const fullPath = join(ROOT, firstPath);

    if (existsSync(fullPath)) {
      const files = findFiles(fullPath, () => true, { skipDirs: ['node_modules', '.git'] });
      const fileCount = files.length;
      if (fileCount > 0) {
        pass(`上游 ${upstream}: 产出物目录存在 (${firstPath}, ${fileCount} 个文件)`);
      } else if (STRICT) {
        fail(`上游 ${upstream}: 产出物目录为空 (${firstPath})`);
      } else {
        warn(`上游 ${upstream}: 产出物目录为空 (${firstPath})`);
      }
    } else if (STRICT) {
      fail(`上游 ${upstream}: 产出物目录不存在 (${firstPath})`);
    } else {
      warn(`上游 ${upstream}: 产出物目录不存在 (${firstPath}) — 非严格模式，跳过`);
    }

    for (const checkCmd of upstreamDef?.completion_checks || []) {
      const cmd = fillSprintPattern(checkCmd);
      const { ok: isOk, stdout, stderr } = tryRun(cmd, { cwd: ROOT });
      if (isOk) {
        pass(`上游 ${upstream}: completion_check 通过: ${cmd}`);
      } else if (STRICT) {
        fail(`上游 ${upstream}: completion_check 未通过: ${cmd}`);
        const tail = (stdout || stderr || '').trim().slice(-1000);
        if (tail) info(tail);
      } else {
        warn(`上游 ${upstream}: completion_check 未通过: ${cmd}`);
      }
    }
  }
}

console.log('');

// ─── 检查 4: 任务就绪信号 (readiness) ──────────────────────────────────────────

info('--- 检查任务就绪信号 ---');

const readiness = taskDef.readiness || {};
const qualityReport = readiness.quality_report;

if (qualityReport) {
  const reportPath = join(ROOT, fillSprintPattern(qualityReport.path));
  if (!existsSync(reportPath)) {
    fail(`质量报告不存在: ${fillSprintPattern(qualityReport.path)}`);
  } else {
    pass(`质量报告存在: ${fillSprintPattern(qualityReport.path)}`);
    const reportText = readText(reportPath);
    for (const marker of qualityReport.markers || []) {
      // marker 作为正则匹配（空格/顺序/状态符号差异容错）；无效正则回退为字面量匹配。
      let matched = false;
      try {
        matched = new RegExp(marker).test(reportText);
      } catch {
        matched = reportText.includes(marker);
      }
      if (matched) {
        pass(`质量信号满足: ${marker}`);
      } else {
        fail(`质量信号缺失: ${marker}`);
      }
    }
  }
} else {
  pass('无额外就绪信号');
}

console.log('');

// ─── 检查 5: 审批记录与产出物结构 ─────────────────────────────────────────────

info('--- 检查审批记录与产出物结构 ---');

const approvalArtifact = taskDef.approval_artifact;
if (approvalArtifact) {
  const approvalPath = join(ROOT, fillSprintPattern(approvalArtifact));
  if (!existsSync(approvalPath)) {
    fail(`审批记录不存在: ${fillSprintPattern(approvalArtifact)}`);
  } else {
    pass(`审批记录存在: ${fillSprintPattern(approvalArtifact)}`);
    try {
      const approval = loadYaml(approvalPath) || {};
      if (approval.decision === 'approved') {
        pass('审批记录状态为 approved');
      } else {
        fail(`审批记录未放行: decision=${approval.decision || '未填写'}`);
      }
    } catch {
      fail(`审批记录不可解析: ${fillSprintPattern(approvalArtifact)}`);
    }
  }
} else {
  pass('无审批记录要求');
}

for (const check of taskDef.preflight_file_checks || []) {
  const rawPath = check.replace(/\s*必须存在.*$/, '').trim();
  const filePath = join(ROOT, fillSprintPattern(rawPath));
  if (existsSync(filePath)) {
    pass(`产出物存在: ${fillSprintPattern(rawPath)}`);
  } else {
    fail(`产出物缺失: ${fillSprintPattern(rawPath)}`);
  }
}

// ─── H-OPT v1.6: deploy-sprint state-file 门控 ───────────────────────────────
// promote-prep / build-image 的输出是 .harness/state/*.json；后续任务必须读 ready/success。
const STATE_GATES = {
  'build-image':  { file: '.harness/state/promote-prep-{env}.json', key: 'ready', envFromSprintId: true },
  'promote-test': { file: '.harness/state/build-image-{sprintId}.json', key: 'success', sprintScoped: true },
};

function resolveBuildImageState(currentSprintId) {
  const stateDir = join(ROOT, '.harness/state');
  const exact = join(stateDir, `build-image-${currentSprintId}.json`);
  if (existsSync(exact)) return { file: exact, label: `.harness/state/build-image-${currentSprintId}.json` };
  if (!existsSync(stateDir)) return { file: exact, label: `.harness/state/build-image-${currentSprintId}.json` };

  const series = currentSprintId.match(/^sprint-\d+/)?.[0] || currentSprintId;
  const candidates = readdirSync(stateDir)
    .filter(name => name.startsWith(`build-image-${series}`) && name.endsWith('.json'))
    .map(name => {
      const file = join(stateDir, name);
      return { file, label: `.harness/state/${name}`, mtimeMs: statSync(file).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    fail(`build-image 状态文件不唯一：${candidates.map(item => item.label).join(', ')}。请清理旧状态或重跑 build-image --sprint ${currentSprintId}`);
  }
  return { file: exact, label: `.harness/state/build-image-${currentSprintId}.json` };
}

const stateGate = STATE_GATES[TASK_TYPE];
if (stateGate) {
  // 取 env：sprint id 形如 sprint-N-deploy-test → 提取末段；缺省 test
  const envMatch = sprintId.match(/(test|prod|staging)/);
  const env = envMatch ? envMatch[1] : 'test';
  const resolvedState = TASK_TYPE === 'promote-test'
    ? resolveBuildImageState(sprintId)
    : {
        label: stateGate.file.replace('{env}', env).replace('{sprintId}', sprintId),
        file: join(ROOT, stateGate.file.replace('{env}', env).replace('{sprintId}', sprintId)),
      };
  const filename = resolvedState.label;
  const stateFile = resolvedState.file;
  if (!existsSync(stateFile)) {
    fail(`部署状态文件缺失: ${filename}（先执行上游任务）`);
  } else {
    try {
      const state = JSON.parse(readText(stateFile));
      if (TASK_TYPE === 'promote-test' && state.sprint !== sprintId) {
        fail(`${filename}: sprint 字段与当前 Sprint 不一致（实际 ${JSON.stringify(state.sprint)}，期望 ${JSON.stringify(sprintId)}）`);
      }
      if (state[stateGate.key] !== true) {
        fail(`${filename}: ${stateGate.key} ≠ true（实际 ${JSON.stringify(state[stateGate.key])}）`);
      } else {
        pass(`部署状态门控通过: ${filename} (${stateGate.key}=true)`);
      }
    } catch (e) {
      fail(`${filename}: JSON 解析失败 — ${e.message}`);
    }
  }
}

// ─── H-OPT v1.6: harness.yml 门控配置 ────────────────────────────────────────
// ui_design_l3：开启时，design / backend-design / frontend-design 任务后的 code 启动需 design 审批记录
// walkthrough_env：仅作为信息项打印（promote-prep 决策由编排者读取）
try {
  const { loadHarnessConfig } = await import('./lib/harness-config.mjs');
  harnessConfig = loadHarnessConfig();
  if (TASK_TYPE === 'code' && harnessConfig.gates?.ui_design_l3 === true) {
    const designApproval = join(ROOT, 'docs/design-docs', `${sprintSeriesId}-design-approval.yml`);
    if (!existsSync(designApproval)) {
      fail(`harness.yml.gates.ui_design_l3=true 但缺少设计审批: ${designApproval}（关闭门控或补 yml: { decision: approved }）`);
    } else {
      try {
        const a = loadYaml(designApproval) || {};
        if (a.decision !== 'approved') fail(`设计审批未放行: decision=${a.decision || '未填写'}`);
        else pass('UI Design L3 审批通过');
      } catch { fail(`设计审批 yml 不可解析: ${designApproval}`); }
    }
  }
  if (['promote-prep', 'promote-test', 'build-image'].includes(TASK_TYPE)) {
    info(`harness.yml.walkthrough_env = ${harnessConfig.walkthrough_env}（编排者据此决定 quality 时机）`);
  }
} catch (e) {
  harnessConfigLoadError = e;
  const envSensitiveTasks = ['code', 'promote-prep', 'promote-test', 'build-image', 'quality', 'product-acceptance', 'pr', 'sprint-close'];
  if (envSensitiveTasks.includes(TASK_TYPE)) {
    fail(`harness.yml 加载失败，无法执行环境敏感任务 ${TASK_TYPE}: ${e.message}`);
  } else {
    warn(`harness.yml 加载失败（当前任务不依赖环境门控）: ${e.message}`);
  }
}

function hasPlannedTask(taskType) {
  if (STRUCTURED_STATUSES.has(taskType)) return true;
  const escaped = taskType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`, 'i').test(sprintContent);
}

function ensureTestWalkthroughPlanShape() {
  if (harnessConfigLoadError || harnessConfig?.walkthrough_env !== 'test') return;
  if (!hasPlannedTask('code')) return;
  const required = ['promote-prep', 'build-image', 'promote-test', 'quality', 'product-acceptance', 'pr', 'sprint-close'];
  const missing = required.filter(task => !hasPlannedTask(task));
  if (missing.length > 0) {
    fail(`walkthrough_env=test 且 Sprint 含 code，计划缺少测试环境闭环任务: ${missing.join(', ')}。必须先补齐计划，再启动/关闭任务`);
  } else {
    pass('walkthrough_env=test 计划结构包含测试部署、质量、走查、PR 与关闭闭环');
  }
}

if (['quality', 'product-acceptance', 'pr', 'sprint-close'].includes(TASK_TYPE)) {
  ensureTestWalkthroughPlanShape();
}

// ─── Test 走查双到达门禁 ─────────────────────────────────────────────────────
function loadApprovalCommitSha() {
  if (!approvalArtifact) return '';
  const approvalPath = join(ROOT, fillSprintPattern(approvalArtifact));
  if (!existsSync(approvalPath)) return '';
  try {
    const approval = loadYaml(approvalPath) || {};
    return String(approval.commit_sha || '').trim();
  } catch {
    return '';
  }
}

function ensureRefContainsCommit(ref, commitSha) {
  const verify = tryRun(`git rev-parse --verify --quiet ${ref}`, { cwd: ROOT });
  if (!verify.ok) {
    fail(`分支引用不存在: ${ref}。请先 git fetch origin --prune 或确认远端分支已创建`);
    return;
  }
  const contains = tryRun(`git merge-base --is-ancestor ${commitSha} ${ref}`, { cwd: ROOT });
  if (contains.ok) pass(`signoff commit_sha 已抵达 ${ref}: ${commitSha}`);
  else fail(`signoff commit_sha 未抵达 ${ref}: ${commitSha}。必须通过 MR 合并，不能用临时部署替代`);
}

if (TASK_TYPE === 'sprint-close') {
  const commitSha = loadApprovalCommitSha();
  if (!commitSha) {
    fail('Boss signoff 缺少 commit_sha，无法验证 PR/MR 是否已抵达目标分支');
  } else {
    const refs = harnessConfig?.walkthrough_env === 'test'
      ? ['origin/develop', 'origin/test']
      : ['origin/develop'];
    const branches = refs.map(ref => ref.replace(/^origin\//, '')).join(' ');
    const fetch = tryRun(`git fetch origin ${branches} --quiet`, { cwd: ROOT });
    if (!fetch.ok) {
      fail(`无法刷新 ${refs.join(' 与 ')}，禁止使用本地陈旧引用关闭 Sprint。请执行 git fetch origin ${branches} --quiet 后重试`);
    }
    for (const ref of refs) ensureRefContainsCommit(ref, commitSha);
  }
}

const artifactGuard = taskDef.artifact_guard;
if (artifactGuard) {
  const cmd = fillSprintPattern(artifactGuard);
  const { ok: isOk, stdout, stderr } = tryRun(cmd, { cwd: ROOT });
  if (isOk) {
    pass(`产出物结构通过: ${cmd}`);
  } else {
    fail(`产出物结构未通过: ${cmd}`);
    if (stdout) info(stdout.trim().slice(0, 400));
    if (stderr) info(stderr.trim().slice(0, 400));
  }
} else {
  pass('无额外产出物结构检查');
}

console.log('');

// ─── 结果汇总 ─────────────────────────────────────────────────────────────────

if (blocked) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`${C.red('BLOCKED')} — 以下条件未满足:`);
  for (const reason of reasons) {
    console.log(`  • ${reason}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(1);
} else {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`${C.green('PASS')} — 所有前置条件已满足，可以开始 ${TASK_TYPE} 任务`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(0);
}
