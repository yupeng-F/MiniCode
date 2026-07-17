#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness validate-task-rules — task-rules.yml 结构校验
//
// 对 lint/task-rules.yml 做 Schema 级校验，防止手工编辑导致字段漂移在运行时才暴露。
// 由 sprint-gate.mjs 在每次前置检查时自动调用；也可独立运行做 CI 早期拦截。
//
// 用法: scripts/validate-task-rules.mjs [--file <path>] [--ci]
// 退出码: 0 = PASS, 1 = 结构错误
// =============================================================================

import {
  parseArgs, loadYaml, projectRoot,
  C, info, ok, warn,
  existsSync, join,
} from './lib/utils.mjs';

const ROOT = projectRoot(import.meta.url);
const { flags, options } = parseArgs(process.argv.slice(2), {
  flags: ['--ci', '--help'],
  options: ['--file'],
});

if (flags.has('--help')) {
  console.log(`用法: scripts/validate-task-rules.mjs [--file <path>] [--ci]
  --file <path>  task-rules.yml 路径（默认 lint/task-rules.yml）
  --ci           CI 模式：错误时退出码 1（默认即如此）`);
  process.exit(0);
}

const FILE = options.get('--file') ?? join(ROOT, 'lint', 'task-rules.yml');

if (!existsSync(FILE)) {
  console.error(`${C.red('✗')} task-rules.yml 不存在: ${FILE}`);
  process.exit(1);
}

// ─── Schema 定义 ─────────────────────────────────────────────────────────────

const KNOWN_GATES = ['L1', 'L3'];
const KNOWN_TASKS = [
  'infra', 'product', 'design', 'backend-design', 'frontend-design',
  'code', 'test-case-gen', 'quality', 'pr', 'product-acceptance',
  'sprint-close', 'observe',
  // CICD.md / deploy-sprint
  'promote-prep', 'build-image', 'promote-test', 'integration',
  'release-prep', 'migration-design', 'regression', 'release-approval',
  'prod-deploy', 'hotfix-init', 'back-merge',
];

const TASK_REQUIRED_FIELDS = ['label', 'gate', 'tools', 'acceptance'];
const TOOLS_REQUIRED_FIELDS = ['allow', 'deny'];
const TASK_KEYWORDS = [...KNOWN_TASKS].sort((a, b) => b.length - a.length);

// ─── 校验 ────────────────────────────────────────────────────────────────────

let errors = 0;
let warnings = 0;
function error(msg) { console.error(`${C.red('✗')} ${msg}`); errors++; }
function warning(msg) { console.warn(`${C.yellow('!')} ${msg}`); warnings++; }

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function extractTaskKeyword(text) {
  return TASK_KEYWORDS.find((name) => String(text || '').includes(name)) || '';
}

function validateScriptReferences(taskName, fieldName, commands) {
  for (const command of toArray(commands)) {
    if (typeof command !== 'string') continue;
    for (const match of command.matchAll(/\bscripts\/([A-Za-z0-9._-]+\.mjs)\b/g)) {
      const scriptPath = join(ROOT, 'scripts', match[1]);
      if (!existsSync(scriptPath)) {
        error(`tasks.${taskName}.${fieldName} 引用不存在脚本: scripts/${match[1]}`);
      }
    }
    if (/sprint-N-name/.test(command)) {
      error(`tasks.${taskName}.${fieldName} 使用 legacy token sprint-N-name；机械路径必须使用 <N-name>`);
    }
  }
}

function collectStrings(value, path = '') {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStrings(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => collectStrings(item, path ? `${path}.${key}` : key));
  }
  return [];
}

function validateNoLegacySprintTokens(taskName, task) {
  for (const { path, value } of collectStrings(task, `tasks.${taskName}`)) {
    if (/sprint-N-name|sprint-N(?:\b|-)/.test(value)) {
      error(`${path} 使用 legacy sprint token: ${value}`);
    }
  }
}

let doc;
try {
  doc = loadYaml(FILE);
} catch (e) {
  error(`YAML 解析失败: ${e.message}`);
  process.exit(1);
}

if (!doc || typeof doc !== 'object') {
  error('task-rules.yml 顶层必须是对象');
  process.exit(1);
}

// version
if (!doc.version) warning('缺少 version 字段');

// sprint_preflight
if (doc.sprint_preflight) {
  const sp = doc.sprint_preflight;
  if (typeof sp.ttl_seconds !== 'number' || sp.ttl_seconds <= 0) {
    error('sprint_preflight.ttl_seconds 必须是正整数（preflight 缓存 TTL，秒）');
  }
}

// tasks
const tasks = doc.tasks || {};
if (Object.keys(tasks).length === 0) {
  error('tasks 为空');
}

// doc_section_rules（可选）
if (doc.doc_section_rules) {
  if (typeof doc.doc_section_rules !== 'object' || Array.isArray(doc.doc_section_rules)) {
    error('doc_section_rules 必须是对象 (目录路径 → 正则数组)');
  } else {
    for (const [dir, patterns] of Object.entries(doc.doc_section_rules)) {
      if (!Array.isArray(patterns)) {
        error(`doc_section_rules["${dir}"] 必须是数组`);
        continue;
      }
      for (const p of patterns) {
        try { new RegExp(p); } catch (e) {
          error(`doc_section_rules["${dir}"] 含非法正则: ${p} (${e.message})`);
        }
      }
    }
  }
}

for (const [name, task] of Object.entries(tasks)) {
  validateNoLegacySprintTokens(name, task);
  if (!KNOWN_TASKS.includes(name)) {
    warning(`未知任务类型: ${name}（期望: ${KNOWN_TASKS.join('|')}）`);
  }

  for (const field of TASK_REQUIRED_FIELDS) {
    if (!(field in task)) {
      error(`tasks.${name} 缺少必填字段: ${field}`);
    }
  }

  // specs / specs-frontend / specs-backend 必须是字符串数组（与 spec/spec-* 共存，加载时优先取 specs*）
  for (const f of ['specs', 'specs-frontend', 'specs-backend']) {
    if (f in task) {
      if (!Array.isArray(task[f]) || task[f].some(s => typeof s !== 'string')) {
        error(`tasks.${name}.${f} 必须是字符串数组`);
      }
    }
  }

  if (task.gate && !KNOWN_GATES.includes(task.gate)) {
    error(`tasks.${name}.gate 非法: ${task.gate}（期望: ${KNOWN_GATES.join('|')}）`);
  }

  if (task.tools) {
    for (const field of TOOLS_REQUIRED_FIELDS) {
      if (!Array.isArray(task.tools[field])) {
        error(`tasks.${name}.tools.${field} 必须是数组`);
      }
    }
  }

  if (task.acceptance && !Array.isArray(task.acceptance)) {
    error(`tasks.${name}.acceptance 必须是数组`);
  }

  if (task.completion_checks) {
    if (!Array.isArray(task.completion_checks) || task.completion_checks.some(item => typeof item !== 'string')) {
      error(`tasks.${name}.completion_checks 必须是字符串数组`);
    }
    validateScriptReferences(name, 'completion_checks', task.completion_checks);
  }

  if (task.prerequisites && !Array.isArray(task.prerequisites)) {
    error(`tasks.${name}.prerequisites 必须是数组`);
  } else {
    for (const prereq of task.prerequisites || []) {
      const keyword = extractTaskKeyword(prereq);
      if (keyword && !tasks[keyword]) error(`tasks.${name}.prerequisites 引用未定义任务: ${keyword}`);
    }
  }

  if (task.prerequisites_any) {
    if (!Array.isArray(task.prerequisites_any)) {
      error(`tasks.${name}.prerequisites_any 必须是数组`);
    } else {
      for (const [idx, group] of task.prerequisites_any.entries()) {
        if (!Array.isArray(group) || group.length === 0 || group.some(item => typeof item !== 'string')) {
          error(`tasks.${name}.prerequisites_any[${idx}] 必须是非空字符串数组`);
        }
      }
    }
  }

  if (task.infra_ready != null && typeof task.infra_ready !== 'string') {
    error(`tasks.${name}.infra_ready 必须是字符串（shell 命令）`);
  }
  validateScriptReferences(name, 'infra_ready', task.infra_ready);
  validateScriptReferences(name, 'artifact_guard', task.artifact_guard);

  if (task.outputs) {
    if (task.outputs.artifacts && !Array.isArray(task.outputs.artifacts)) {
      error(`tasks.${name}.outputs.artifacts 必须是数组`);
    }
  }

  if (task.readiness?.quality_report) {
    const qr = task.readiness.quality_report;
    if (!qr.path) error(`tasks.${name}.readiness.quality_report 缺少 path`);
    if (qr.path && /sprint-N-name/.test(qr.path)) {
      error(`tasks.${name}.readiness.quality_report.path 使用 legacy token sprint-N-name；机械路径必须使用 <N-name>`);
    }
    if (qr.markers && !Array.isArray(qr.markers)) {
      error(`tasks.${name}.readiness.quality_report.markers 必须是数组`);
    }
    // 正则语法校验
    for (const m of qr.markers || []) {
      try { new RegExp(m); } catch (e) {
        error(`tasks.${name}.readiness.quality_report.markers 含非法正则: ${m} (${e.message})`);
      }
    }
  }
}

// gates
const gates = doc.gates || {};
for (const level of KNOWN_GATES) {
  if (!gates[level]) warning(`gates.${level} 未定义`);
}

// spawn_rules
if (doc.spawn_rules && !Array.isArray(doc.spawn_rules)) {
  error('spawn_rules 必须是数组');
} else {
  for (const [idx, rule] of (doc.spawn_rules || []).entries()) {
    for (const from of toArray(rule.from)) {
      if (!tasks[from]) error(`spawn_rules[${idx}].from 引用未定义任务: ${from}`);
    }
    for (const to of toArray(rule.to)) {
      if (!tasks[to]) error(`spawn_rules[${idx}].to 引用未定义任务: ${to}`);
    }
  }
}

// ─── 结果 ────────────────────────────────────────────────────────────────────

console.log();
if (errors > 0) {
  console.error(`${C.red('FAIL')} task-rules.yml 结构校验失败: ${errors} 错误, ${warnings} 警告`);
  process.exit(1);
}
if (warnings > 0) {
  console.log(`${C.yellow('PASS (with warnings)')} task-rules.yml: ${warnings} 警告`);
} else {
  ok('task-rules.yml 结构校验通过');
}
process.exit(0);
