#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness test-case-validator — 测试用例 YAML 字段校验
//
// 对 test-cases/**/*.yml 做结构校验，防止字段漂移导致 quality-score.mjs 运行时失败。
// 规范见 docs/TEST_CASES.md。
//
// 用法: scripts/test-case-validator.mjs [--dir <path>] [--sprint <N-name>] [--ci]
//   --dir     测试用例目录（默认 test-cases/）
//   --sprint  仅校验 introduced_in/last_modified_in 关联到指定 sprint 的用例
//   --ci      CI 模式：错误时退出码 1
// =============================================================================

import {
  parseArgs, loadYaml, projectRoot, findFiles,
  C, info, ok,
  existsSync, join, readText,
} from './lib/utils.mjs';

const ROOT = projectRoot(import.meta.url);
const { flags, options } = parseArgs(process.argv.slice(2), {
  flags: ['--ci', '--help'],
  options: ['--dir', '--sprint'],
});

if (flags.has('--help')) {
  console.log(`用法: scripts/test-case-validator.mjs [--dir <path>] [--sprint <N-name>] [--ci]
  --dir     测试用例目录（默认 test-cases/）
  --sprint  仅校验 introduced_in/last_modified_in 关联到指定 sprint 的用例
  --ci      CI 模式：错误时退出码 1（默认）`);
  process.exit(0);
}

const DIR = options.get('--dir') ?? join(ROOT, 'test-cases');
const SPRINT = options.get('--sprint') ?? '';

if (!existsSync(DIR)) {
  console.log(`${C.yellow('!')} 测试用例目录不存在: ${DIR} — 跳过校验`);
  process.exit(0);
}

const SCAN_DIR = DIR;

// ─── Schema ──────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['id', 'title', 'priority', 'last_verified_in', 'preconditions', 'steps', 'tags', 'spec'];
const VALID_PRIORITIES = ['P0', 'P1', 'P2'];
const VALID_MODES = ['standard', 'live'];

let errors = 0;
let warnings = 0;
let total = 0;
let liveCount = 0;

function fail(msg) { console.error(`${C.red('✗')} ${msg}`); errors++; }
function warn(msg) { console.warn(`${C.yellow('!')} ${msg}`); warnings++; }

function validateCase(file) {
  total++;
  const rel = file.replace(ROOT + '/', '');
  let doc;
  try {
    doc = loadYaml(file);
  } catch (e) {
    fail(`${rel}: YAML 解析失败 — ${e.message}`);
    return;
  }
  if (!doc || typeof doc !== 'object') {
    fail(`${rel}: 顶层必须是对象`);
    return;
  }

  const introduced = doc.introduced_in || doc.sprint;
  const lastModified = doc.last_modified_in || introduced;
  if (SPRINT) {
    const normalizedSprint = SPRINT.startsWith('sprint-') ? SPRINT : `sprint-${SPRINT}`;
    const related = [introduced, lastModified, doc.last_verified_in]
      .map(value => value ? String(value) : '')
      .map(value => value.startsWith('sprint-') ? value : (value ? `sprint-${value}` : ''))
      .includes(normalizedSprint);
    if (!related) {
      total--;
      return;
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in doc) || doc[field] === null || doc[field] === '') {
      fail(`${rel}: 缺少必填字段 ${field}`);
    }
  }

  if (!introduced) {
    fail(`${rel}: 缺少必填字段 introduced_in（legacy sprint 也可临时兼容，但新用例必须使用 introduced_in）`);
  }
  if (!doc.last_modified_in) {
    warn(`${rel}: 缺少 last_modified_in；迁移期使用 introduced_in/sprint 推断，新增/修改用例必须显式填写`);
  }
  if ('sprint' in doc) {
    warn(`${rel}: sprint 字段为 legacy；请改为 introduced_in，并在 index.md 记录 last_modified_in`);
  }

  if (doc.priority && !VALID_PRIORITIES.includes(doc.priority)) {
    fail(`${rel}: priority 非法 (${doc.priority})，期望 ${VALID_PRIORITIES.join('|')}`);
  }

  if (doc.preconditions && !Array.isArray(doc.preconditions)) {
    fail(`${rel}: preconditions 必须是数组`);
  }
  if (doc.tags && !Array.isArray(doc.tags)) {
    fail(`${rel}: tags 必须是数组`);
  }
  if (doc.steps) {
    if (!Array.isArray(doc.steps)) {
      fail(`${rel}: steps 必须是数组`);
    } else {
      for (let i = 0; i < doc.steps.length; i++) {
        const s = doc.steps[i];
        if (!s || typeof s !== 'object') {
          fail(`${rel}: steps[${i}] 必须是对象`);
          continue;
        }
        if (!s.action) fail(`${rel}: steps[${i}].action 缺失`);
        if (!s.expected) fail(`${rel}: steps[${i}].expected 缺失`);
      }
    }
  }

  // spec 路径存在性
  if (doc.spec && typeof doc.spec === 'string') {
    const specPath = join(ROOT, doc.spec);
    if (!existsSync(specPath)) {
      warn(`${rel}: spec 文件不存在 — ${doc.spec}（若已生成 Playwright spec 请确认路径）`);
    }
  }

  // execution 模式校验
  if (doc.execution) {
    const mode = doc.execution.mode || 'standard';
    if (!VALID_MODES.includes(mode)) {
      fail(`${rel}: execution.mode 非法 (${mode})，期望 ${VALID_MODES.join('|')}`);
    }
    if (mode === 'live') {
      liveCount++;
      // G-7: live 用例须说明 env 或 mock_reason
      const hasEnv = doc.execution.env && Object.keys(doc.execution.env).length > 0;
      const hasMockReason = typeof doc.execution.mock_reason === 'string' && doc.execution.mock_reason.trim();
      if (!hasEnv && !hasMockReason) {
        fail(`${rel}: execution.mode=live 须声明 execution.env（真实 KEY 开关）或 execution.mock_reason（G-7）`);
      }
      // env 不应含密钥 — 只放开关
      for (const [k, v] of Object.entries(doc.execution.env || {})) {
        if (typeof v === 'string' && /[A-Za-z0-9+/=]{16,}/.test(v) && !/^(0|1|true|false|yes|no)$/i.test(v)) {
          warn(`${rel}: execution.env.${k} 疑似包含敏感值，密钥应走 .env 而非用例文件`);
        }
      }
    }
  }
}

// ─── 扫描 ────────────────────────────────────────────────────────────────────

const files = findFiles(SCAN_DIR, (_p, name) => /\.ya?ml$/.test(name) && name !== 'index.yml');

info(`Harness test-case-validator — 扫描 ${files.length} 个用例`);
console.log();

for (const file of files) validateCase(file);

// ─── 结果 ────────────────────────────────────────────────────────────────────

console.log();
console.log(`用例总数: ${total}，其中 live: ${liveCount}`);
if (errors > 0) {
  console.error(`${C.red('FAIL')} ${errors} 错误, ${warnings} 警告`);
  process.exit(1);
}
if (warnings > 0) {
  console.log(`${C.yellow('PASS (with warnings)')} ${warnings} 警告`);
} else {
  ok('所有测试用例结构合规');
}
process.exit(0);
