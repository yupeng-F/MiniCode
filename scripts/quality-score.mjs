#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — 质量评分计算器 (QUALITY_SCORE.md 代码化)
//
// 自动收集各检查步骤结果，计算 100 分制质量评分。
// 消除 Agent 手动计算的主观性和误差。
//
// 触发者: harness-exec 的 quality 任务环节（非 CI，需运行中的服务）
//
// 用法:
//   quality-score.mjs --sprint <N-name> [--level L1|L2|L3] [--report-dir path] [--threshold N] [--coverage-dir path]
//   quality-score.mjs --release <vX.Y.Z> [--level L1|L2|L3] [--report-dir path] [--threshold N] [--coverage-dir path]
//
// --sprint / --release 二选一，用于生成质量报告文件
// 默认阈值: 95 分（与 QUALITY_SCORE.md 一致）
// 退出码: 0 = 达标, 1 = 不达标
// =============================================================================

import {
  parseArgs, tryRun, findFiles, loadYaml, writeText, mdTable, timestamp,
  info, ok, warn, err, C,
  existsSync, readFileSync, join, relative, rmSync,
} from './lib/utils.mjs';
import { pathToFileURL } from 'node:url';
import { loadHarnessConfig } from './lib/harness-config.mjs';
import { getEnvironment, loadEnvironmentsCompat } from './lib/deploy-config.mjs';
import { applyLocalRuntimeEnvToProcessEnv } from './lib/local-runtime-env.mjs';
import { applySecretsToProcessEnv } from './lib/secrets-file.mjs';
import { resolveRequiredSecrets } from './lib/required-secrets.mjs';

// ─── 框架级配置（config/harness.yml）─────────────────────────────────
let HARNESS_CONFIG;
try { HARNESS_CONFIG = loadHarnessConfig(); }
catch (e) { err(`harness.yml 加载失败：${e.message}`); process.exit(2); }

// ─── 参数解析 ────────────────────────────────────────────────────────────────

const { flags, options } = parseArgs(process.argv.slice(2), {
  options: ['--report-dir', '--threshold', '--coverage-dir', '--sprint', '--level', '--release'],
});

const HELP_TEXT = `用法: quality-score.mjs (--sprint <N-name> | --release <vX.Y.Z>) [--level L1|L2|L3] [--report-dir path] [--threshold N] [--coverage-dir path]
  --sprint:       Sprint 标识，如 "5-mock-adapter"。用于报告命名、E2E 用例定位
  --release:      Release 标识；未提供 --sprint 时会生成 release-<version> 的质量报告
  --level:        质量层级（CICD.md 三层测试矩阵），默认 L1
                    L1 = develop / sprint / promote 分支：unit + ui-audit + e2e-smoke
                    L2 = test / release 分支：integration + migration-check
                    L3 = main 分支前置：regression + perf + observability
  --report-dir:   报告输出目录 (默认: docs/test-reports)
  --threshold:    达标阈值 (默认: 95)
  --coverage-dir: 覆盖率目录 (默认: coverage)`;

const RELEASE_ID = options.get('--release');
const SPRINT_ID = options.get('--sprint') || (RELEASE_ID ? `release-${RELEASE_ID}` : null);

const LEVEL = (options.get('--level') || 'L1').toUpperCase();
const VALID_LEVELS = new Set(['L1', 'L2', 'L3']);
// LEVEL 用于在报告头声明评分层级；维度筛选由 quality.yml 调度对应步骤实现，
// 此处不做维度裁剪，保持单一维度计算逻辑。详见 CICD.md。

const REPORT_DIR = options.get('--report-dir') || 'docs/test-reports';
// H-OPT v1.6: 阈值优先来自 harness.yml.gates.quality_threshold，--threshold 显式覆盖
const THRESHOLD = parseInt(options.get('--threshold') || String(HARNESS_CONFIG.gates.quality_threshold), 10);
const COVERAGE_DIR = options.get('--coverage-dir') || 'coverage';
const TEST_CASES_DIR = 'test-cases';
const REMOTE_API_BASE_URL_ENV_NAMES = ['E2E_API_URL', 'TEST_API_BASE_URL', 'API_URL'];

// ─── E2E 测试用例辅助函数 ───────────────────────────────────────────────────

function normalizeSprintId(value) {
  if (!value) return '';
  const text = String(value).trim();
  return text.startsWith('sprint-') ? text : `sprint-${text}`;
}

function qualityReportBasename(value) {
  return `${normalizeSprintId(value)}-quality`;
}

function normalizeCaseMetadata(testCase) {
  const introduced = testCase.introduced_in || testCase.sprint || '';
  const lastModified = testCase.last_modified_in || introduced;
  return {
    ...testCase,
    introduced_in: introduced,
    last_modified_in: lastModified,
    last_verified_in: testCase.last_verified_in || lastModified || introduced,
    // Legacy alias retained for report grouping while projects migrate.
    sprint: testCase.sprint || introduced,
  };
}

/** 从指定目录加载所有 .yml 测试用例；v1.6 起用例扁平存放于 test-cases/，递归兼容旧 sprint 子目录 */
function loadTestCases(dir) {
  if (!existsSync(dir)) return [];
  const files = findFiles(dir, (_fp, name) => name.endsWith('.yml'), { skipDirs: [] });
  const cases = [];
  for (const f of files) {
    try {
      const tc = loadYaml(f);
      if (tc && tc.id && tc.spec) cases.push({
        ...normalizeCaseMetadata(tc),
        test_titles: Array.isArray(tc.test_titles) ? tc.test_titles.map(title => String(title)) : [],
        execution: normalizeExecution(tc.execution),
      });
    } catch { /* skip malformed */ }
  }
  return cases;
}

function normalizeExecution(execution) {
  if (!execution) {
    return { mode: 'standard', env: {} };
  }
  if (typeof execution === 'string') {
    return { mode: execution, env: {} };
  }
  return {
    mode: execution.mode || 'standard',
    env: execution.env && typeof execution.env === 'object' ? execution.env : {},
  };
}

/** 从测试用例数组提取去重后的 spec 路径列表 */
function mapCasesToSpecs(cases) {
  return [...new Set(cases.map(c => c.spec).filter(Boolean))];
}

function isCurrentSprintCase(testCase, currentSprint) {
  const current = normalizeSprintId(currentSprint);
  return [testCase.introduced_in, testCase.last_modified_in, testCase.sprint]
    .map(normalizeSprintId)
    .includes(current);
}

/** 收集所有历史（非当前）的 P0 用例 */
function collectP0Cases(testCasesDir, currentSprint) {
  if (!existsSync(testCasesDir)) return [];
  return loadTestCases(testCasesDir)
    .filter(c => c.priority === 'P0' && !isCurrentSprintCase(c, currentSprint));
}

/** 收集所有历史 Sprint（非当前）的 P0 用例对应的 spec */
function collectP0Specs(testCasesDir, currentSprint) {
  return mapCasesToSpecs(collectP0Cases(testCasesDir, currentSprint));
}

function getCaseTags(testCase) {
  return Array.isArray(testCase.tags)
    ? testCase.tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean)
    : [];
}

const specLocalOnlyCache = new Map();

function isSpecMarkedLocalOnly(specPath) {
  const normalizedSpec = normalizePath(specPath || '');
  if (!normalizedSpec || !existsSync(normalizedSpec)) return false;
  if (specLocalOnlyCache.has(normalizedSpec)) return specLocalOnlyCache.get(normalizedSpec);
  let isLocalOnly = false;
  try {
    const source = readFileSync(normalizedSpec, 'utf-8');
    isLocalOnly = /Mode:\s*LOCAL ONLY/i.test(source)
      || /test\.skip\(isTest\(\)/.test(source);
  } catch {
    isLocalOnly = false;
  }
  specLocalOnlyCache.set(normalizedSpec, isLocalOnly);
  return isLocalOnly;
}

function hasRemoteExecutionTarget(env = process.env) {
  return Boolean(readFirstDefinedEnvValue(REMOTE_API_BASE_URL_ENV_NAMES, env));
}

function isLocalOnlyCase(testCase) {
  const tags = getCaseTags(testCase);
  const preconditions = Array.isArray(testCase.preconditions) ? testCase.preconditions.join(' ') : '';
  return testCase.execution?.mode === 'local'
    || tags.includes('local')
    || /(?:^|\b)e2e_mode\s*=\s*local\b|local-only/i.test(preconditions);
}

function isMockOnlyCase(testCase) {
  const tags = getCaseTags(testCase);
  return tags.includes('mode-mock')
    || tags.includes('mock-only')
    || tags.includes('mode-integration');
}

function isP0RegressionCompatible(testCase, env = process.env) {
  if (!hasRemoteExecutionTarget(env)) return true;
  return !isLocalOnlyCase(testCase)
    && !isMockOnlyCase(testCase)
    && !isSpecMarkedLocalOnly(testCase.spec);
}

function groupRegressionCases(cases) {
  const groups = new Map();
  for (const testCase of [...cases].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const sprint = testCase.sprint || '—';
    const spec = testCase.spec || '—';
    const envEntries = Object.entries(testCase.execution?.env || {})
      .sort(([left], [right]) => left.localeCompare(right));
    const grepPattern = buildCaseGrepPattern(testCase);
    const key = JSON.stringify([sprint, spec, envEntries]);
    if (!groups.has(key)) {
      groups.set(key, {
        sprint,
        spec,
        env: Object.fromEntries(envEntries),
        grepPatterns: [],
        caseIds: [],
      });
    }
    const group = groups.get(key);
    if (grepPattern) group.grepPatterns.push(grepPattern);
    group.caseIds.push(testCase.id);
  }
  return [...groups.values()].map(group => ({
    ...group,
    grepPattern: [...new Set(group.grepPatterns)].filter(Boolean).join('|'),
  }));
}

function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function uniquePaths(paths) {
  return [...new Set(paths.map(normalizePath))];
}

function shellEscape(value) {
  return `'${String(value).replaceAll('\'', '\'\\\'\'')}'`;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCaseGrepPattern(testCase) {
  const titles = Array.isArray(testCase.test_titles) && testCase.test_titles.length > 0
    ? testCase.test_titles
    : (testCase.title ? [testCase.title] : []);
  if (titles.length === 0) return '';
  // Playwright greps against the full computed title, which may include describe prefixes.
  return titles.map(title => regexEscape(title)).join('|');
}

function buildFallbackCaseGrepPattern(testCase) {
  return testCase?.id ? regexEscape(String(testCase.id)) : '';
}

function buildEnvPrefix(env = {}) {
  const entries = Object.entries(env);
  if (entries.length === 0) return '';
  return `${entries.map(([key, value]) => `${key}=${shellEscape(value)}`).join(' ')} `;
}

function readConfiguredE2EAuthMode(env = process.env) {
  const envName = env.E2E_CONFIG_ENV || 'test';
  try {
    const cfg = env.E2E_CONFIG_PATH ? loadYaml(env.E2E_CONFIG_PATH) : loadEnvironmentsCompat();
    return cfg?.environments?.[envName]?.e2e?.auth_mode || '';
  } catch {
    return '';
  }
}

function buildRemoteE2EEnv(env = process.env) {
  const apiBaseUrl = readFirstDefinedEnvValue(['E2E_API_URL', 'TEST_API_BASE_URL'], env);
  const baseUrl = readFirstDefinedEnvValue(['E2E_BASE_URL', 'TEST_PUBLIC_BASE_URL', 'TEST_API_BASE_URL'], env);
  if (!apiBaseUrl || !baseUrl) return {};

  const remoteEnv = {
    E2E_MODE: readFirstDefinedEnvValue(['E2E_MODE'], env) || 'test',
    E2E_BASE_URL: baseUrl,
    E2E_API_URL: apiBaseUrl,
    E2E_USE_WEBSERVER: '0',
  };

  const authMode = readFirstDefinedEnvValue(['E2E_AUTH_MODE'], env) || readConfiguredE2EAuthMode(env);
  if (authMode) {
    remoteEnv.E2E_AUTH_MODE = authMode;
  }

  return remoteEnv;
}

function isE2ESpecPath(specPath = '') {
  return normalizePath(String(specPath || '')).startsWith('e2e/');
}

function splitCasesByRunner(cases) {
  const e2eCases = [];
  const standardCases = [];
  for (const testCase of cases) {
    if (isE2ESpecPath(testCase.spec)) e2eCases.push(testCase);
    else standardCases.push(testCase);
  }
  return { e2eCases, standardCases };
}

function buildPlaywrightCommand({ specs = [], grepPattern = '', env = {}, reporter = '' } = {}) {
  const normalizedSpecs = Array.isArray(specs) ? specs.filter(Boolean) : [specs].filter(Boolean);
  const specArgs = normalizedSpecs.map(shellEscape).join(' ');
  const grepArg = grepPattern ? ` --grep ${shellEscape(grepPattern)}` : '';
  const reporterArg = reporter ? ` --reporter=${reporter}` : '';
  const envPrefix = buildEnvPrefix({
    ...buildRemoteE2EEnv(process.env),
    ...env,
    PLAYWRIGHT_REUSE_EXISTING_SERVER: 'true',
  });
  return `${envPrefix}pnpm test:e2e${specArgs ? ` ${specArgs}` : ''}${grepArg}${reporterArg} 2>/dev/null`;
}

function formatEnvLabel(env = {}) {
  const entries = Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(', ');
}

function collectPlaywrightNodes(root, predicate, acc = []) {
  if (!root || typeof root !== 'object') return acc;
  if (Array.isArray(root)) {
    for (const value of root) collectPlaywrightNodes(value, predicate, acc);
    return acc;
  }
  if (predicate(root)) acc.push(root);
  for (const value of Object.values(root)) {
    collectPlaywrightNodes(value, predicate, acc);
  }
  return acc;
}

function extractPlaywrightSkipReason(report) {
  const annotationReasons = collectPlaywrightNodes(report, node => Array.isArray(node.annotations))
    .flatMap(node => node.annotations)
    .filter(annotation => annotation?.type === 'skip' && typeof annotation.description === 'string')
    .map(annotation => annotation.description.trim())
    .filter(Boolean);

  if (annotationReasons.length > 0) return annotationReasons[0];

  const errorReasons = collectPlaywrightNodes(report, node => typeof node.error?.message === 'string')
    .map(node => String(node.error.message).trim())
    .filter(Boolean);

  return errorReasons[0] || '';
}

function summarizePlaywrightCaseRun(runResult) {
  if (!runResult.stdout) {
    return { status: runResult.ok ? 'passed' : 'failed', reason: '' };
  }

  try {
    const jsonStart = runResult.stdout.indexOf('{');
    const report = JSON.parse(jsonStart >= 0 ? runResult.stdout.slice(jsonStart) : runResult.stdout);
    const stats = report?.stats || {};
    const statuses = collectPlaywrightNodes(report, node => typeof node.status === 'string')
      .map(node => String(node.status));
    if ((stats.unexpected || 0) > 0 || statuses.some(status => ['failed', 'timedOut', 'interrupted'].includes(status))) {
      return { status: 'failed', reason: '' };
    }
    if ((stats.skipped || 0) > 0 || (statuses.length > 0 && statuses.every(status => status === 'skipped'))) {
      return { status: 'skipped', reason: extractPlaywrightSkipReason(report) };
    }
    if ((stats.expected || 0) > 0 || (stats.flaky || 0) > 0 || statuses.some(status => status === 'passed')) {
      return { status: 'passed', reason: '' };
    }
  } catch {
    // fall back to exit-code-based classification
  }

  return { status: runResult.ok ? 'passed' : 'failed', reason: '' };
}

function isNoTestsFoundRun(runResult) {
  const output = [runResult?.stdout || '', runResult?.stderr || ''].join('\n');
  return /No tests found\./i.test(output);
}

function runPlaywrightCase({ spec, grepPattern = '', fallbackGrepPattern = '', env = {}, reporter = 'json' }) {
  let runResult = tryRun(buildPlaywrightCommand({ specs: [spec], grepPattern, env, reporter }));
  if (!runResult.ok && grepPattern && isNoTestsFoundRun(runResult) && fallbackGrepPattern && fallbackGrepPattern !== grepPattern) {
    runResult = tryRun(buildPlaywrightCommand({ specs: [spec], grepPattern: fallbackGrepPattern, env, reporter }));
  }
  return runResult;
}

function requiresAuthenticatedLivePrereq(testCase) {
  const preconditions = Array.isArray(testCase.preconditions) ? testCase.preconditions.join(' ') : '';
  return /E2E_STORAGE_STATE|真实登录|自动化真实认证链路|微信 OAuth|企微\/微信 OAuth/i.test(preconditions);
}

function isConditionalRealAuthCase(testCase) {
  const tags = Array.isArray(testCase.tags) ? testCase.tags.map(tag => String(tag).toLowerCase()) : [];
  return requiresAuthenticatedLivePrereq(testCase)
    && (tags.includes('test') || String(testCase.title || '').startsWith('Test 模式'));
}

function formatSkippedLabel(reason) {
  return reason ? `⚠️ skipped（${reason}）` : '⚠️ skipped';
}

function shouldRunP0Regression(level) {
  return ['L1', 'L2', 'L3'].includes(level);
}

function isLiveGatePassed(caseResult) {
  const result = typeof caseResult === 'string' ? { status: caseResult, reason: '' } : (caseResult || { status: 'failed', reason: '' });
  return result.status === 'passed';
}

function formatCurrentCaseResult(testCase, caseResult) {
  const result = typeof caseResult === 'string' ? { status: caseResult, reason: '' } : (caseResult || { status: 'failed', reason: '' });
  const { status, reason } = result;
  if (testCase.execution?.mode === 'live') {
    return status === 'passed'
      ? '✅ 通过（真实链路）'
      : status === 'skipped'
        ? `${formatSkippedLabel(reason)}（真实链路）`
        : '❌ 失败（真实链路）';
  }
  if (status === 'standard-only') {
    return '↪️ standard / unit（由 Step 2 覆盖，不纳入 Step 5 E2E）';
  }
  if (isConditionalRealAuthCase(testCase)) {
    return '⚠️ 前提未满足（需真实登录，不纳入默认评分）';
  }
  if (status === 'passed') return '✅ 通过（当前迭代）';
  if (status === 'skipped') {
    return formatSkippedLabel(reason);
  }
  return '❌ 失败（当前迭代）';
}

function groupLiveCasesByEnv(cases) {
  const groups = new Map();
  for (const testCase of cases.filter(tc => tc.execution?.mode === 'live')) {
    const envEntries = Object.entries(testCase.execution?.env || {})
      .sort(([left], [right]) => left.localeCompare(right));
    const env = Object.fromEntries(envEntries);
    const key = JSON.stringify(envEntries);
    if (!groups.has(key)) {
      groups.set(key, {
        env,
        envKeys: envEntries.map(([name]) => name),
        cases: [],
        specs: new Set(),
      });
    }
    const group = groups.get(key);
    group.cases.push(testCase.id);
    group.specs.add(testCase.spec);
  }
  return [...groups.values()].map(group => ({
    ...group,
    specs: [...group.specs],
  }));
}

function summarizeCaseVerification(testCase) {
  const expectations = Array.isArray(testCase.steps)
    ? testCase.steps
      .map(step => typeof step?.expected === 'string' ? step.expected.trim() : '')
      .filter(Boolean)
    : [];
  if (expectations.length === 0) return testCase.title || '—';
  return `${testCase.title || '未命名用例'}；${expectations.join('；')}`;
}

function groupCasesBySprintAndSpec(cases) {
  const groups = new Map();
  for (const testCase of [...cases].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const sprint = testCase.sprint || '—';
    const spec = testCase.spec || '—';
    const key = `${sprint}::${spec}`;
    if (!groups.has(key)) {
      groups.set(key, {
        sprint,
        spec,
        caseIds: [],
      });
    }
    groups.get(key).caseIds.push(testCase.id);
  }
  return [...groups.values()];
}

export {
  buildFallbackCaseGrepPattern,
  buildServiceHealthCommand,
  buildPlaywrightCommand,
  formatCurrentCaseResult,
  isE2ESpecPath,
  isLiveGatePassed,
  shouldRunP0Regression,
  splitCasesByRunner,
  summarizePlaywrightCaseRun,
  runPlaywrightCase,
  qualityReportBasename,
};

function readFirstDefinedEnvValue(names, env = process.env) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function normalizeWebBaseUrl(raw) {
  return normalizeApiBaseUrl(raw);
}

function hydrateWalkthroughRemoteEnv(env = process.env) {
  const walkthroughEnv = String(HARNESS_CONFIG.walkthrough_env || '').trim();
  if (!walkthroughEnv || !['test', 'prod'].includes(walkthroughEnv)) return;

  let deployEntry;
  try {
    deployEntry = getEnvironment(walkthroughEnv);
  } catch {
    return;
  }

  const requiredSecrets = resolveRequiredSecrets(walkthroughEnv, deployEntry);
  const snapshot = applySecretsToProcessEnv(walkthroughEnv, requiredSecrets);
  if (!snapshot.exists || snapshot.error) return;

  const prefix = walkthroughEnv.toUpperCase();
  const apiBaseUrl = readFirstDefinedEnvValue([`${prefix}_API_BASE_URL`], env);
  const webBaseUrl = readFirstDefinedEnvValue([`${prefix}_PUBLIC_BASE_URL`, `${prefix}_WEB_URL`, `${prefix}_API_BASE_URL`], env);

  if (apiBaseUrl && !env.API_URL) {
    env.API_URL = normalizeApiBaseUrl(apiBaseUrl);
  }
  if (webBaseUrl && !env.WEB_URL) {
    env.WEB_URL = normalizeWebBaseUrl(webBaseUrl);
  }

  const prefixed = walkthroughEnv.toUpperCase();
  const copyIfMissing = (target, ...sources) => {
    if (env[target]) return;
    const value = readFirstDefinedEnvValue(sources, env);
    if (value) env[target] = value;
  };
  copyIfMissing(`${prefixed}_PASSWORD_LOGIN_USERNAME`, 'PASSWORD_LOGIN_USERNAME');
  copyIfMissing(`${prefixed}_PASSWORD_LOGIN_PASSWORD`, 'PASSWORD_LOGIN_PASSWORD');
  copyIfMissing(`${prefixed}_PASSWORD_LOGIN_USER_ID`, 'PASSWORD_LOGIN_USER_ID');
  copyIfMissing(`${prefixed}_PASSWORD_LOGIN_DISPLAY_NAME`, 'PASSWORD_LOGIN_DISPLAY_NAME');
  copyIfMissing(`${prefixed}_PASSWORD_LOGIN_ROLE`, 'PASSWORD_LOGIN_ROLE');
  copyIfMissing(`${prefixed}_JWT_SECRET`, 'JWT_SECRET');
}

function normalizeApiBaseUrl(raw) {
  let url = raw.trim().replace(/\/+$/u, '');
  if (url.endsWith('/api')) {
    url = url.slice(0, -4);
  }
  return url;
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function buildRemoteHealthCommand(env = process.env) {
  const apiBaseUrl = readFirstDefinedEnvValue(REMOTE_API_BASE_URL_ENV_NAMES, env);
  if (!apiBaseUrl) return null;
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  return [
    `curl -fsS --max-time 10 ${quoteShell(`${normalizedApiBaseUrl}/health`)} >/dev/null`,
    `curl -fsS --max-time 10 ${quoteShell(`${normalizedApiBaseUrl}/ready`)} >/dev/null`,
  ].join(' && ');
}

function buildServiceHealthCommand(env = process.env, cwd = process.cwd()) {
  const remoteCommand = buildRemoteHealthCommand(env);
  if (remoteCommand) {
    return {
      command: remoteCommand,
      detail: '✅ 通过（remote health endpoints）',
      mode: 'remote',
    };
  }

  const verifyScript = join(cwd, 'scripts', 'verify.mjs');
  if (!existsSync(verifyScript)) {
    return null;
  }

  return {
    command: `node "${verifyScript}" health 2>/dev/null`,
    detail: '✅ 通过（verify.mjs health）',
    mode: 'local',
  };
}

function safeReadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function loadRootPackageJson() {
  if (!existsSync('package.json')) return null;
  try {
    return safeReadJson('package.json');
  } catch {
    return null;
  }
}

function findKnownFiles(baseDir, predicate, opts = {}) {
  if (!existsSync(baseDir)) return [];
  return findFiles(baseDir, predicate, { skipDirs: ['node_modules', '.git'], ...opts })
    .map(normalizePath);
}

function normalizeCoverageSourcePath(filePath) {
  const normalized = filePath.startsWith('/')
    ? normalizePath(relative(process.cwd(), filePath))
    : normalizePath(filePath);
  if (normalized.startsWith('src/') && existsSync(join('web', normalized))) {
    return normalized.replace(/^src\//, 'web/');
  }
  if (normalized.startsWith('src/') && existsSync(join('src', normalized))) {
    return normalized;
  }
  if (normalized.includes('web/src/')) return normalized.replace(/^.*?web\/src\//, 'web/');
  if (normalized.includes('src/src/')) return normalized.replace(/^.*?src\/src\//, 'src/');
  if (normalized.includes('src/')) return normalized.replace(/^.*?src\//, 'src/');
  return normalized;
}

function isBusinessCoverageFile(filePath) {
  const target = normalizeCoverageSourcePath(filePath);

  if (
    target.includes('/coverage/')
    || target.includes('/node_modules/')
    || target.includes('/test-results/')
    || target.includes('/docs/')
    || target.includes('/e2e/')
    || target.includes('/scripts/')
    || target.includes('/dist/')
    || target.includes('/public/')
    || target.includes('/__tests__/')
    || target.includes('/__mocks__/')
    || target.endsWith('.test.ts')
    || target.endsWith('.test.js')
    || target.endsWith('.spec.ts')
    || target.endsWith('.spec.js')
    || target.endsWith('.d.ts')
    || target.endsWith('.config.ts')
    || target.endsWith('.config.js')
    || target.endsWith('.config.mjs')
  ) {
    return false;
  }

  return [
    'src/modules/',
    'src/services/',
    'src/providers/',
    'src/shared/',
    'src/plugins/',
    'src/routes/',
    'src/lib/',
    'web/',
  ].some(segment => target.includes(segment));
}

function bucketCoverageName(filePath) {
  return normalizeCoverageSourcePath(filePath);
}

function discoverCoverageFiles() {
  const candidateDirs = uniquePaths([
    COVERAGE_DIR,
    'coverage',
    'src/coverage',
    'web/coverage',
  ]);

  const discovered = findFiles('.', (_fp, name) =>
    name === 'coverage-summary.json' || name === 'coverage-final.json',
    { skipDirs: ['node_modules', '.git', '.worktrees', 'docs', 'test-results'], maxDepth: 5 },
  );

  const ordered = [
    ...candidateDirs.flatMap(dir => ([
      join(dir, 'coverage-summary.json'),
      join(dir, 'coverage-final.json'),
    ])),
    ...discovered,
  ];

  return uniquePaths(ordered.filter(filePath => existsSync(filePath)));
}

function collectCoverageData() {
  const coverageFiles = discoverCoverageFiles();
  const byFile = new Map();
  const sourcesUsed = [];
  const storeCoverageStat = (filePath, nextStats) => {
    const current = byFile.get(filePath);
    if (!current) {
      byFile.set(filePath, nextStats);
      return;
    }
    if (
      nextStats.covered > current.covered
      || (nextStats.covered === current.covered && nextStats.total > current.total)
      || (current.total === 0 && nextStats.total > 0)
      || (current.covered === 0 && nextStats.covered > 0)
    ) {
      byFile.set(filePath, nextStats);
    }
  };

  for (const coverageFile of coverageFiles) {
    try {
      const json = safeReadJson(coverageFile);
      const normalizedCoverageFile = normalizePath(coverageFile);
      sourcesUsed.push(normalizedCoverageFile);

      if (normalizedCoverageFile.endsWith('coverage-summary.json')) {
        for (const [filePath, stats] of Object.entries(json)) {
          if (filePath === 'total' || !stats?.statements) continue;
          if (!isBusinessCoverageFile(filePath)) continue;
          storeCoverageStat(normalizePath(filePath), {
            total: stats.statements.total ?? 0,
            covered: stats.statements.covered ?? 0,
            pct: stats.statements.pct ?? 0,
          });
        }
        continue;
      }

      for (const [filePath, fileData] of Object.entries(json)) {
        if (!isBusinessCoverageFile(filePath)) continue;
        const statementCounts = Object.values(fileData?.s || {});
        const total = statementCounts.length;
        const covered = statementCounts.filter(count => count > 0).length;
        storeCoverageStat(normalizePath(filePath), {
          total,
          covered,
          pct: total > 0 ? (covered / total) * 100 : 0,
        });
      }
    } catch {
      warn(`覆盖率文件解析失败，已跳过: ${coverageFile}`);
    }
  }

  const coverageRows = [...byFile.entries()]
    .map(([filePath, stats]) => ({
      filePath,
      label: bucketCoverageName(filePath),
      total: stats.total,
      covered: stats.covered,
      pct: stats.pct,
    }))
    .filter(row => row.total > 0)
    .sort((a, b) => a.label.localeCompare(b.label));

  const totalStatements = coverageRows.reduce((sum, row) => sum + row.total, 0);
  const coveredStatements = coverageRows.reduce((sum, row) => sum + row.covered, 0);

  return {
    coverageRows,
    coveragePct: totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0,
    sourcesUsed: uniquePaths(sourcesUsed),
  };
}

function isIntegrationTestFile(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized.startsWith('e2e/')) return false;
  return (
    normalized.includes('.integration.')
    || normalized.includes('.int.')
    || /(^|\/)__tests__\/integration[^/]*\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    || /integration\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function runFirstPassing(commands) {
  let lastResult = { ok: false, stdout: '', stderr: '', exitCode: 1 };
  for (const command of commands) {
    const result = tryRun(command);
    if (result.ok) return { command, ...result };
    lastResult = { command, ...result };
  }
  return lastResult;
}

function discoverWorkspacePackages() {
  return findFiles('.', (filePath, name) => name === 'package.json' && normalizePath(filePath) !== 'package.json', {
    skipDirs: ['node_modules', '.git', '.worktrees', 'coverage', 'dist', 'docs', 'test-results'],
    maxDepth: 2,
  })
    .map(normalizePath)
    .filter(filePath => filePath.split('/').length <= 3)
    .map(filePath => {
      try {
        const pkg = safeReadJson(filePath);
        return {
          dir: filePath.replace(/\/package\.json$/, ''),
          testScript: pkg?.scripts?.test || '',
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function toVitestCoverageCommand(testScript) {
  if (!testScript.includes('vitest')) return null;
  const normalized = testScript
    .replace(/^vitest run\b/, 'pnpm exec vitest run')
    .replace(/^vitest\b/, 'pnpm exec vitest');
  const withCoverage = normalized.includes('--coverage')
    ? normalized
    : normalized.includes('pnpm exec vitest run')
      ? normalized.replace('pnpm exec vitest run', 'pnpm exec vitest run --coverage')
      : `${normalized} --coverage`;
  return withCoverage.includes('--coverage.reporter=')
    ? withCoverage
    : `${withCoverage} --coverage.reporter=json-summary`;
}

function groupFilesByWorkspace(files = []) {
  const groups = new Map();
  for (const filePath of files.map(normalizePath)) {
    const cwd = filePath.startsWith('src/') ? 'src'
      : filePath.startsWith('web/') ? 'web'
      : '.';
    const relativePath = cwd === '.' ? filePath : filePath.slice(cwd.length + 1);
    if (!groups.has(cwd)) {
      groups.set(cwd, []);
    }
    groups.get(cwd).push(relativePath);
  }
  return [...groups.entries()].map(([cwd, groupFiles]) => ({ cwd, files: uniquePaths(groupFiles) }));
}

function runUnitCoverage() {
  const commandsRun = [];
  const unitEnv = buildUnitTestEnv(process.env);
  for (const coverageFile of [
    join('coverage', 'coverage-summary.json'),
    join('coverage', 'coverage-final.json'),
    join('src', 'coverage', 'coverage-summary.json'),
    join('src', 'coverage', 'coverage-final.json'),
    join('web', 'coverage', 'coverage-summary.json'),
    join('web', 'coverage', 'coverage-final.json'),
  ]) {
    if (existsSync(coverageFile)) {
      rmSync(coverageFile, { force: true });
    }
  }
  const workspacePackages = discoverWorkspacePackages()
    .map(pkg => ({ ...pkg, coverageCommand: toVitestCoverageCommand(pkg.testScript) }))
    .filter(pkg => pkg.coverageCommand);

  if (workspacePackages.length === 0) {
    const primaryCommand = 'pnpm test -- --coverage --silent 2>/dev/null';
    const primaryResult = tryRun(primaryCommand, { env: unitEnv });
    commandsRun.push({ cwd: '.', command: primaryCommand, ok: primaryResult.ok });
    return { ok: primaryResult.ok, coverageData: collectCoverageData(), commandsRun };
  }

  let allOk = true;
  for (const pkg of workspacePackages) {
    const result = tryRun(pkg.coverageCommand, { cwd: pkg.dir, env: unitEnv });
    commandsRun.push({ cwd: pkg.dir, command: pkg.coverageCommand, ok: result.ok });
    if (!result.ok) allOk = false;
  }

  const coverageData = collectCoverageData();
  return { ok: allOk, coverageData, commandsRun };
}

function buildUnitTestEnv(env = process.env) {
  const unitEnv = { ...env };
  for (const key of [
    'API_URL',
    'WEB_URL',
    'E2E_MODE',
    'E2E_BASE_URL',
    'E2E_API_URL',
    'E2E_USE_WEBSERVER',
    'E2E_AUTH_MODE',
    'E2E_PASSWORD_LOGIN_USERNAME',
    'E2E_PASSWORD_LOGIN_PASSWORD',
    'TEST_API_BASE_URL',
    'TEST_PUBLIC_BASE_URL',
    'PLAYWRIGHT_BASE_URL',
    'PLAYWRIGHT_API_BASE_URL',
  ]) {
    delete unitEnv[key];
  }
  return unitEnv;
}

// ─── 权重定义（与 QUALITY_SCORE.md §评分权重 一致）──────────────────────────

const W_STATIC = 15;       // Step 1: 静态检查
const W_UNIT = 20;          // Step 2: 单元测试 + 覆盖率
const W_INTEGRATION = 10;   // Step 3: 集成测试
const W_SERVICE = 5;        // Step 4: 服务健康
const W_E2E = 15;           // Step 5: E2E 测试
const W_UI_PERF = 25;       // Step 6: UI + 性能 (Agent 手动评分，此处取默认)
const W_PERF = 10;          // 性能基线

const TOTAL_WEIGHT = W_STATIC + W_UNIT + W_INTEGRATION + W_SERVICE + W_E2E + W_UI_PERF + W_PERF;

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
if (flags.has('--help')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (!SPRINT_ID) {
  err('--sprint 或 --release 参数必填。用法: quality-score.mjs --sprint 5-mock-adapter');
  process.exit(1);
}

if (!VALID_LEVELS.has(LEVEL)) {
  err(`--level 必须是 L1|L2|L3，当前值: ${LEVEL}`);
  process.exit(1);
}

applyLocalRuntimeEnvToProcessEnv();

console.log('');
info('==========================================');
info(` Harness 质量评分计算器`);
info(` Sprint: ${SPRINT_ID}`);
info(` 层级: ${LEVEL}（CICD.md）`);
info(` 阈值: ${THRESHOLD} 分 / 满分: ${TOTAL_WEIGHT} 分`);
info('==========================================');
console.log('');

let totalScore = 0;
const details = [];  // [label, score, max, weight%]
const reportSections = [];  // Markdown sections for detailed report
const hardFailures = [];

// ─── Step 1: 静态检查 (typecheck + lint) ─────────────────────────────────────

info(`--- Step 1: 静态检查 (${W_STATIC}分) ---`);

let s1Score = 0;
const typecheckOk = tryRun('pnpm typecheck 2>&1 >/dev/null').ok;
const lintOk = tryRun('pnpm lint --quiet 2>/dev/null').ok;

if (typecheckOk && lintOk) {
  s1Score = W_STATIC;
  console.log(`${C.green('✅ typecheck + lint 通过')} → ${s1Score}/${W_STATIC}`);
} else if (typecheckOk || lintOk) {
  s1Score = Math.floor(W_STATIC / 2);
  console.log(`${C.yellow(`⚠️  部分通过 (typecheck=${typecheckOk}, lint=${lintOk})`)} → ${s1Score}/${W_STATIC}`);
} else {
  console.log(`${C.red('❌ typecheck + lint 均失败')} → 0/${W_STATIC}`);
}
totalScore += s1Score;
details.push(['静态检查', String(s1Score), String(W_STATIC), '15%']);
reportSections.push(`### Step 1: 静态检查 (${s1Score}/${W_STATIC})\n- TypeCheck: ${typecheckOk ? '✅' : '❌'}\n- Lint: ${lintOk ? '✅' : '❌'}`);

console.log('');

// ─── Step 2: 单元测试 + 覆盖率 ──────────────────────────────────────────────

info(`--- Step 2: 单元测试 + 覆盖率 (${W_UNIT}分) ---`);

let s2Score = 0;
let coveragePct = 0;
let coverageModules = [];
let coverageSources = [];
let coverageCommands = [];

const unitCoverageResult = runUnitCoverage();
const testResult = { ok: unitCoverageResult.ok };
coverageCommands = unitCoverageResult.commandsRun.map(entry =>
  entry.cwd === '.'
    ? `${entry.command} (${entry.ok ? 'ok' : 'fail'})`
    : `${entry.cwd}: ${entry.command} (${entry.ok ? 'ok' : 'fail'})`,
);

if (testResult.ok) {
  s2Score = Math.floor(W_UNIT / 2);  // 测试通过得一半分

  const coverageData = unitCoverageResult.coverageData;
  coveragePct = coverageData.coveragePct;
  coverageSources = coverageData.sourcesUsed;
  coverageModules = coverageData.coverageRows.map(row => [row.label, `${row.pct.toFixed(1)}%`]);

  if (coverageModules.length > 0) {
    if (coveragePct >= 80) {
      s2Score = W_UNIT;
    } else if (coveragePct >= 60) {
      s2Score = Math.floor(W_UNIT * 3 / 4);
    }
    console.log(`${C.green(`✅ 测试通过，覆盖率 ${coveragePct.toFixed(1)}% (${coverageSources.length} 个报告源)`)} → ${s2Score}/${W_UNIT}`);
  } else {
    console.log(`${C.yellow('⚠️  测试通过，但未识别到业务代码覆盖率')} → ${s2Score}/${W_UNIT}`);
  }
} else {
  console.log(`${C.red('❌ 测试失败')} → 0/${W_UNIT}`);
}
totalScore += s2Score;
details.push(['单元测试 + 覆盖率', String(s2Score), String(W_UNIT), '20%']);
reportSections.push([
  `### Step 2: 单元测试 + 覆盖率 (${s2Score}/${W_UNIT})`,
  coverageCommands.length > 0 ? `- 执行命令:\n${coverageCommands.map(command => `  - \`${command}\``).join('\n')}` : '',
  `- 总覆盖率: ${coveragePct.toFixed(1)}%`,
  coverageSources.length > 0 ? `- 覆盖率报告源:\n${coverageSources.map(f => `  - \`${f}\``).join('\n')}` : '- 覆盖率报告源: 未发现',
  coverageModules.length > 0 ? `\n**模块覆盖率**:\n${mdTable(['模块', '覆盖率'], coverageModules)}` : '',
].filter(Boolean).join('\n'));

console.log('');

// ─── Step 3: 集成测试 ───────────────────────────────────────────────────────

info(`--- Step 3: 集成测试 (${W_INTEGRATION}分) ---`);

let s3Score = 0;
const rootPackageJson = loadRootPackageJson();
const hasIntegrationScript = !!rootPackageJson?.scripts?.['test:integration'];
const integrationFiles = findFiles('.', (filePath) =>
  isIntegrationTestFile(filePath),
  { skipDirs: ['node_modules', '.git', '.worktrees', 'coverage', 'dist'] },
).map(normalizePath);
const intTestCount = integrationFiles.length;
let integrationCommand = hasIntegrationScript ? 'pnpm test:integration' : '未执行';

if (hasIntegrationScript || intTestCount > 0) {
  if (hasIntegrationScript) {
    const intResult = tryRun('pnpm test:integration 2>/dev/null');
    integrationCommand = 'pnpm test:integration 2>/dev/null';
    if (intResult.ok) {
      s3Score = W_INTEGRATION;
      console.log(`${C.green(`✅ 集成测试通过 (${intTestCount} 个文件)`)} → ${s3Score}/${W_INTEGRATION}`);
    } else {
      console.log(`${C.red('❌ 集成测试失败')} → 0/${W_INTEGRATION}`);
    }
  } else {
    const groupedIntegrationFiles = groupFilesByWorkspace(integrationFiles)
      .filter(group => group.cwd !== '.');
    const integrationRuns = groupedIntegrationFiles.map(group => {
      // eslint-disable-next-line harness/no-sql-concatenation -- Shell command assembly for vitest file list, not SQL.
      const command = `pnpm exec vitest run ${group.files.map(shellEscape).join(' ')} 2>/dev/null`;
      const result = tryRun(command, { cwd: group.cwd });
      return { ...group, command, ok: result.ok };
    });
    integrationCommand = integrationRuns.length > 0
      ? integrationRuns.map(run => `${run.cwd}: ${run.command}`).join('; ')
      : integrationCommand;
    if (integrationRuns.length > 0 && integrationRuns.every(run => run.ok)) {
      s3Score = W_INTEGRATION;
      console.log(`${C.green(`✅ 集成测试通过 (${intTestCount} 个文件)`)} → ${s3Score}/${W_INTEGRATION}`);
    } else {
      console.log(`${C.red('❌ 集成测试失败')} → 0/${W_INTEGRATION}`);
    }
  }
} else {
  if (LEVEL === 'L1') {
    s3Score = Math.floor(W_INTEGRATION / 2);
    console.log(`${C.yellow('⚠️  未找到集成测试文件')} → ${s3Score}/${W_INTEGRATION} (L1 基础分)`);
  } else {
    hardFailures.push(`${LEVEL} 要求集成测试，但未找到 test:integration 或 integration spec`);
    console.log(`${C.red(`❌ ${LEVEL} 要求集成测试，但未找到测试入口`)} → 0/${W_INTEGRATION}`);
  }
}
totalScore += s3Score;
details.push(['集成测试', String(s3Score), String(W_INTEGRATION), '10%']);
reportSections.push([
  `### Step 3: 集成测试 (${s3Score}/${W_INTEGRATION})`,
  `- 执行命令: \`${integrationCommand}\``,
  `- 集成测试文件: ${intTestCount}`,
  intTestCount > 0 ? `- 文件列表:\n${integrationFiles.map(f => `  - \`${f}\``).join('\n')}` : '',
].filter(Boolean).join('\n'));

console.log('');

// ─── Step 4: 服务健康 ───────────────────────────────────────────────────────

info(`--- Step 4: 服务健康 (${W_SERVICE}分) ---`);

hydrateWalkthroughRemoteEnv(process.env);

let s4Score = 0;
let serviceHealthDetail = '❌ 失败';

const verifyScript = join(process.cwd(), 'scripts', 'verify.mjs');
const serviceHealth = buildServiceHealthCommand(process.env, process.cwd());
if (serviceHealth) {
  const healthResult = tryRun(serviceHealth.command);
  if (healthResult.ok) {
    s4Score = W_SERVICE;
    serviceHealthDetail = serviceHealth.detail;
    console.log(`${C.green('✅ 服务健康检查通过')} → ${s4Score}/${W_SERVICE}`);
  } else {
    console.log(`${C.yellow('⚠️  服务健康检查失败或服务未运行')} → 0/${W_SERVICE}`);
    hardFailures.push('服务健康检查未通过');
  }
} else {
  serviceHealthDetail = '❌ verify.mjs 不可用';
  hardFailures.push('服务健康检查入口不存在');
  console.log(`${C.red('❌ verify.mjs 不可用')} → 0/${W_SERVICE}`);
}
totalScore += s4Score;
details.push(['服务健康', String(s4Score), String(W_SERVICE), '5%']);
reportSections.push(`### Step 4: 服务健康 (${s4Score}/${W_SERVICE})\n- 检查结果: ${serviceHealthDetail}`);

console.log('');

// ─── Step 5: E2E 测试（当前迭代全量 + P0 跨迭代回归）─────────────────────────

info(`--- Step 5: E2E 测试 (${W_E2E}分) ---`);

let s5Score = 0;
const currentSprintDir = join(TEST_CASES_DIR, `sprint-${SPRINT_ID}`); // legacy fallback label for report wording
const allStructuredCases = loadTestCases(TEST_CASES_DIR);
const currentCases = allStructuredCases.filter(testCase => isCurrentSprintCase(testCase, SPRINT_ID));
const { e2eCases: currentE2ECases, standardCases: currentStandardCases } = splitCasesByRunner(currentCases);
const currentSpecs = mapCasesToSpecs(currentE2ECases);
const currentStandardSpecs = mapCasesToSpecs(currentStandardCases);
const liveCases = currentE2ECases
  .filter(testCase => testCase.execution?.mode === 'live')
  .sort((left, right) => String(left.id).localeCompare(String(right.id)));
const p0RegressionCases = collectP0Cases(TEST_CASES_DIR, SPRINT_ID);
const compatibleP0RegressionCases = p0RegressionCases.filter(testCase => isP0RegressionCompatible(testCase));
const p0RegressionSpecs = mapCasesToSpecs(compatibleP0RegressionCases);
const p0RegressionGroups = groupCasesBySprintAndSpec(p0RegressionCases);
const runnableP0RegressionGroups = groupRegressionCases(compatibleP0RegressionCases);

// Fallback: 若无结构化测试用例，按旧模式扫描 e2e/scenarios/
const e2eFallbackFiles = findFiles('e2e/scenarios', (_fp, name) =>
  name.endsWith('.spec.ts') || name.endsWith('.spec.js'),
  { skipDirs: ['node_modules'] },
);

const hasStructuredCases = currentCases.length > 0;
let currentOk = false;
let regressionOk = false;
let e2eReportLines = [];
let liveChainOk = true;
let liveChainGroups = [];
const currentCaseResults = new Map();
const liveCaseResults = new Map();
const p0RegressionCaseResults = new Map();

if (hasStructuredCases) {
  info(`  当前迭代用例: ${currentCases.length} 个 (${currentSpecs.length} spec)`);
  if (currentStandardCases.length > 0) {
    info(`  runner 修正: ${currentStandardCases.length} 个 standard 用例留在 Step 2（${currentStandardSpecs.length} spec）`);
  }
  info(`  P0 回归用例: ${shouldRunP0Regression(LEVEL) ? p0RegressionSpecs.length : 0} spec`);

  for (const testCase of currentCases) {
    if (!isE2ESpecPath(testCase.spec)) {
      currentCaseResults.set(testCase.id, {
        status: 'standard-only',
        reason: '由 Step 2 覆盖，不纳入 Step 5 E2E',
      });
    } else if (testCase.execution?.mode === 'live') {
      currentCaseResults.set(testCase.id, {
        status: 'pending-live',
        reason: '真实链路用例由 live gate 执行一次并复用结果',
      });
    }
  }

  const currentStandardGroups = groupRegressionCases(
    currentE2ECases.filter(testCase => testCase.execution?.mode !== 'live'),
  );
  for (const group of currentStandardGroups) {
    const fallbackGrepPattern = group.caseIds.length === 1 ? regexEscape(group.caseIds[0]) : '';
    const standardRun = runPlaywrightCase({
      spec: group.spec,
      grepPattern: group.grepPattern,
      fallbackGrepPattern,
      reporter: 'json',
    });
    const groupResult = summarizePlaywrightCaseRun(standardRun);
    for (const caseId of group.caseIds) currentCaseResults.set(caseId, groupResult);
  }

  liveChainGroups = groupLiveCasesByEnv(currentCases);
  if (liveCases.length > 0) {
    liveChainOk = true;
    const currentLiveGroups = groupRegressionCases(liveCases);
    for (const group of currentLiveGroups) {
      const envLabel = formatEnvLabel(group.env);
      const fallbackGrepPattern = group.caseIds.length === 1 ? regexEscape(group.caseIds[0]) : '';
      const liveResult = runPlaywrightCase({
        spec: group.spec,
        grepPattern: group.grepPattern,
        fallbackGrepPattern,
        env: group.env,
        reporter: 'json',
      });
      const groupResult = summarizePlaywrightCaseRun(liveResult);
      liveChainOk = liveChainOk && isLiveGatePassed(groupResult);
      for (const caseId of group.caseIds) {
        liveCaseResults.set(caseId, groupResult);
        currentCaseResults.set(caseId, groupResult);
      }
      const liveLabel = groupResult.status === 'passed'
        ? '✅ 通过'
        : groupResult.status === 'skipped'
          ? formatSkippedLabel(groupResult.reason)
          : '❌ 失败';
      e2eReportLines.push(`- 真实链路: ${liveLabel} (${group.caseIds.length} case / 1 spec / env: ${envLabel})`);
    }
  } else {
    e2eReportLines.push('- 真实链路: — 未声明 live 用例');
  }

  currentOk = currentCases
    .filter(testCase => isE2ESpecPath(testCase.spec) && !isConditionalRealAuthCase(testCase))
    .every(testCase => currentCaseResults.get(testCase.id)?.status === 'passed');
  e2eReportLines.unshift(`- 当前迭代: ${currentOk ? '✅ 通过' : '❌ 失败'} (${currentSpecs.length} spec)`);
  if (currentStandardCases.length > 0) {
    e2eReportLines.splice(1, 0, `- Runner 修正: ${currentStandardCases.length} 个 standard 用例（${currentStandardSpecs.length} spec）由 Step 2 覆盖，不纳入 Step 5 E2E`);
  }

  // P0 跨迭代回归（传递文件路径作为 positional 参数）
  if (!shouldRunP0Regression(LEVEL)) {
    regressionOk = true;
    e2eReportLines.push(`- P0 回归: — ${LEVEL} 不执行 (${p0RegressionSpecs.length} spec)`);
  } else if (runnableP0RegressionGroups.length > 0) {
    regressionOk = true;
    for (const group of runnableP0RegressionGroups) {
      const fallbackGrepPattern = group.caseIds.length === 1 ? regexEscape(group.caseIds[0]) : '';
      const regResult = runPlaywrightCase({
        spec: group.spec,
        grepPattern: group.grepPattern,
        fallbackGrepPattern,
        env: group.env,
        reporter: '',
      });
      regressionOk = regressionOk && regResult.ok;
      for (const caseId of group.caseIds) {
        p0RegressionCaseResults.set(caseId, regResult.ok ? 'passed' : 'failed');
      }
    }
    e2eReportLines.push(`- P0 回归: ${regressionOk ? '✅ 通过' : '❌ 失败'} (${runnableP0RegressionGroups.length} case group / ${p0RegressionSpecs.length} spec)`);
  } else {
    regressionOk = true; // 无历史 P0 视为通过
    e2eReportLines.push('- P0 回归: ✅ 通过 (0 compatible spec)');
  }

  // 两项均通过才得分
  if (currentOk && regressionOk && liveChainOk) {
    s5Score = W_E2E;
    console.log(`${C.green(`✅ E2E 测试全部通过 (迭代 ${currentSpecs.length} + 回归 ${p0RegressionSpecs.length})`)} → ${s5Score}/${W_E2E}`);
  } else {
    console.log(`${C.red(`❌ E2E 测试未全部通过 (迭代=${currentOk}, 回归=${regressionOk}, 真实链路=${liveChainOk})`)} → 0/${W_E2E}`);
  }
} else if (e2eFallbackFiles.length > 0) {
  // Fallback: 无结构化用例，使用旧模式
  info(`  未找到当前迭代结构化测试用例 (introduced_in/last_modified_in=${normalizeSprintId(SPRINT_ID)}；legacy ${currentSprintDir})，回退到 e2e/scenarios/ 扫描`);
  const e2eResult = tryRun(buildPlaywrightCommand());
  if (e2eResult.ok) {
    s5Score = W_E2E;
    currentOk = true;
    regressionOk = true;
    console.log(`${C.green(`✅ E2E 测试通过 (${e2eFallbackFiles.length} 个场景文件)`)} → ${s5Score}/${W_E2E}`);
  } else {
    console.log(`${C.red(`❌ E2E 测试失败 (${e2eFallbackFiles.length} 个场景文件)`)} → 0/${W_E2E}`);
  }
  e2eReportLines.push(`- Fallback 模式: ${e2eFallbackFiles.length} 个场景文件`);
  e2eReportLines.push(`- 结果: ${s5Score === W_E2E ? '✅ 全部通过' : '❌ 失败'}`);
} else {
  console.log(`${C.red('❌ 未找到 E2E 测试用例或场景文件')} → 0/${W_E2E}`);
  e2eReportLines.push('- ⚠️ 未找到 E2E 测试用例或场景文件');
}
totalScore += s5Score;
details.push(['E2E 测试', String(s5Score), String(W_E2E), '15%']);
const currentScenarioRows = currentCases.map(testCase => [
  `\`${testCase.id}\``,
  summarizeCaseVerification(testCase),
  `\`${testCase.spec}\``,
  testCase.execution?.mode || 'standard',
  formatEnvLabel(testCase.execution?.env),
  formatCurrentCaseResult(testCase, currentCaseResults.get(testCase.id)),
]);
const liveCaseRows = liveCases.map(testCase => [
  `\`${testCase.id}\``,
  summarizeCaseVerification(testCase),
  `\`${testCase.spec}\``,
  formatEnvLabel(testCase.execution?.env),
  liveCaseResults.has(testCase.id)
    ? formatCurrentCaseResult(testCase, liveCaseResults.get(testCase.id))
    : '—',
]);
const p0RegressionRows = p0RegressionGroups.map(group => [
  group.sprint,
  group.caseIds.map(caseId => `\`${caseId}\``).join(', '),
  `\`${group.spec}\``,
  !shouldRunP0Regression(LEVEL)
    ? `— ${LEVEL} 不执行`
    : group.caseIds.some(caseId => {
      const testCase = p0RegressionCases.find(item => item.id === caseId);
      return testCase && !isP0RegressionCompatible(testCase);
    })
      ? '↪️ 不兼容当前环境（已跳过）'
      : group.caseIds.every(caseId => p0RegressionCaseResults.get(caseId) === 'passed')
        ? '✅ 通过（P0 回归）'
        : group.caseIds.some(caseId => p0RegressionCaseResults.get(caseId) === 'failed')
          ? '❌ 失败（P0 回归）'
          : '— 未执行',
]);
reportSections.push([
  `### Step 5: E2E 测试 (${s5Score}/${W_E2E})`,
  hasStructuredCases ? `- 当前迭代用例: ${currentCases.length} 个` : '- 模式: Fallback (e2e/scenarios/)',
  ...e2eReportLines,
  hasStructuredCases && currentScenarioRows.length > 0
    ? `\n**E2E 用例结果（当前迭代）**:\n${mdTable(
      ['TC ID', '标题/验证内容', 'Spec', '执行模式', 'Env', '结果'],
      currentScenarioRows,
    )}`
    : '',
  hasStructuredCases
    ? liveCaseRows.length > 0
      ? `\n**真实链路用例结果**:\n${mdTable(
        ['TC ID', '标题/验证内容', 'Spec', 'Env', '结果'],
        liveCaseRows,
      )}`
      : '\n**真实链路用例结果**:\n- — 未声明 live 用例'
    : '',
  hasStructuredCases && p0RegressionRows.length > 0
    ? `\n**P0 回归场景列表**:\n${mdTable(
      ['Sprint', 'TC ID', 'Spec', '结果'],
      p0RegressionRows,
    )}`
    : '',
].join('\n'));

console.log('');

// ─── Step 6: UI 还原度 + 性能基线 ───────────────────────────────────────────

info(`--- Step 6: UI 还原度 + 性能基线 (${W_UI_PERF}+${W_PERF}分) ---`);

// UI 还原度判分：以 prototype-parity 为唯一依据。
// 满分需同时满足：① 原型 100% 注册 ② 契约最低强度 ③ ui-audit.json 全 PASS
const UI_AUDIT_REPORT = 'coverage/ui-audit.json';
const uiSubChecks = [];

// ① 原型覆盖
const coverageRun = tryRun(`node scripts/check-prototype-coverage.mjs --sprint ${SPRINT_ID}`);
uiSubChecks.push({ label: '原型 100% 注册', passed: coverageRun.ok, output: (coverageRun.stdout || '') + (coverageRun.stderr || '') });

// ② 契约最低强度
const strengthRun = tryRun(`node scripts/check-contract-strength.mjs --sprint ${SPRINT_ID}`);
uiSubChecks.push({ label: '契约最低强度', passed: strengthRun.ok, output: (strengthRun.stdout || '') + (strengthRun.stderr || '') });

// ③ ui-audit.json 全 PASS
// 自动重跑 ui-audit：Step 2 vitest --coverage 会清空 coverage/ 目录（v8 provider 默认 clean=true），
// 把外部预跑的 ui-audit.json 一并删除。所以 Step 6 必须自己生成最新报告。
let auditPassed = false;
let auditPagesCount = 0;
let auditFailDetail = '未生成 coverage/ui-audit.json';
const auditRun = tryRun(`node scripts/ui-audit.mjs --sprint ${SPRINT_ID}`);
if (!auditRun.ok && !existsSync(UI_AUDIT_REPORT)) {
  auditFailDetail = `ui-audit 执行失败: ${(auditRun.stderr || auditRun.stdout || '').slice(0, 400)}`;
}
if (existsSync(UI_AUDIT_REPORT)) {
  try {
    const auditReport = JSON.parse(readFileSync(UI_AUDIT_REPORT, 'utf-8'));
    auditPagesCount = Array.isArray(auditReport.pages) ? auditReport.pages.length : 0;
    auditPassed = auditReport.passed === true && (auditReport.required === false || auditPagesCount > 0);
    if (!auditPassed) {
      const failed = (auditReport.pages || []).filter((p) => !p.passed).map((p) => p.name);
      auditFailDetail = failed.length ? `失败页：${failed.join(', ')}` : 'ui-audit 报告未通过';
    } else {
      auditFailDetail = `${auditPagesCount} 页全部通过`;
    }
  } catch (e) {
    auditFailDetail = `解析 ui-audit.json 失败: ${e.message}`;
  }
}
uiSubChecks.push({ label: 'prototype-parity 全 PASS', passed: auditPassed, output: auditFailDetail });

const allUiPassed = uiSubChecks.every((c) => c.passed);
const s6Score = allUiPassed ? W_UI_PERF : 0;
for (const c of uiSubChecks) {
  console.log(`  ${c.passed ? C.green('✅') : C.red('❌')} ${c.label} — ${c.passed ? 'PASS' : 'FAIL'}`);
}
console.log(`${allUiPassed ? C.green('✅ UI 还原度') : C.red('❌ UI 还原度')} → ${s6Score}/${W_UI_PERF}`);

const uiScreenshotFiles = existsSync('coverage/ui-audit')
  ? findKnownFiles('coverage/ui-audit', (_fp, name) => name.endsWith('.png'), { maxDepth: 4 })
  : [];
const screenshotCount = uiScreenshotFiles.length;
const screenshotRoots = screenshotCount > 0 ? ['coverage/ui-audit'] : [];
const htmlReportFiles = uniquePaths(findKnownFiles('coverage/e2e-report', (_fp, name) => name.endsWith('.html'), { maxDepth: 4 }));
const hasE2eReport = htmlReportFiles.length > 0;

totalScore += s6Score;
details.push(['UI 还原度', String(s6Score), String(W_UI_PERF), '25%']);

// 性能基线
let s7Score = 0;
const hasLighthouse = existsSync('coverage/lighthouse.json');
const hasK6 = existsSync('coverage/k6-results.json');
if (hasLighthouse || hasK6) {
  s7Score = W_PERF;
  console.log(`${C.green('✅ 性能测试结果存在')} → ${s7Score}/${W_PERF}`);
} else {
  if (LEVEL === 'L3') {
    hardFailures.push('L3 要求性能基线，但缺少 lighthouse.json / k6-results.json');
    console.log(`${C.red('❌ L3 缺少性能测试结果（lighthouse.json / k6-results.json）')} → 0/${W_PERF}`);
  } else {
    s7Score = Math.floor(W_PERF / 2);
    console.log(`${C.yellow('⚠️  无性能测试结果（lighthouse.json / k6-results.json）')} → ${s7Score}/${W_PERF} (${LEVEL} 基础分)`);
  }
}
totalScore += s7Score;
details.push(['性能基线', String(s7Score), String(W_PERF), '10%']);

reportSections.push([
  `### Step 6: UI 还原度 (${s6Score}/${W_UI_PERF}) + 性能基线 (${s7Score}/${W_PERF})`,
  '',
  '**UI 还原度判分依据（三项必须全 PASS）**:',
  ...uiSubChecks.map((c) => `- ${c.passed ? '✅' : '❌'} ${c.label} — ${c.output ? c.output.trim().split('\n').pop() : ''}`),
  '',
  screenshotRoots.length > 0 ? `- 命中的截图根目录: ${screenshotRoots.map(root => `\`${root}\``).join(', ')}` : '- 命中的截图根目录: 无',
  '',
  '**prototype-vs-live 截图**:',
  screenshotCount > 0
    ? uiScreenshotFiles.map(f => `- \`${f}\``).join('\n')
  : '- ⚠️ 无截图产出（ui-audit 未能生成 coverage/ui-audit/）',
  '',
  '**E2E HTML 报告**:',
  hasE2eReport
    ? htmlReportFiles.map(f => `- \`${f}\``).join('\n')
    : '- ⚠️ 无 HTML report',
  '',
  '**性能基线**:',
  hasLighthouse ? '- ✅ `coverage/lighthouse.json`' : '- ❌ `coverage/lighthouse.json` 不存在',
  hasK6 ? '- ✅ `coverage/k6-results.json`' : '- ❌ `coverage/k6-results.json` 不存在',
].join('\n'));

console.log('');

// ─── 汇总 ────────────────────────────────────────────────────────────────────

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(C.bold('质量评分明细:'));
for (const [label, score, max] of details) {
  console.log(`  ${label}: ${score}/${max}`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const passed = totalScore >= THRESHOLD && hardFailures.length === 0;

if (passed) {
  console.log(`\n${C.green(C.bold(`总分: ${totalScore} / ${TOTAL_WEIGHT} — ✅ 达标 (阈值: ${THRESHOLD})`))}\n`);
} else {
  console.log(`\n${C.red(C.bold(`总分: ${totalScore} / ${TOTAL_WEIGHT} — ❌ 不达标 (阈值: ${THRESHOLD})`))}\n`);
}

// ─── 输出报告文件 ────────────────────────────────────────────────────────────

try {
  const reportBase = qualityReportBasename(SPRINT_ID);
  const reportFile = join(REPORT_DIR, `${reportBase}.md`);

  const tableRows = [
    ...details.map(([label, score, max, weight]) => [label, score, max, weight]),
    [`**总分**`, `**${totalScore}**`, `**${TOTAL_WEIGHT}**`, ''],
  ];

  const reportContent = [
    `# Sprint ${SPRINT_ID} 质量评分报告`,
    '',
    `- **Sprint**: ${SPRINT_ID}`,
    `- **层级**: ${LEVEL}（CICD.md）`,
    `- **生成时间**: ${timestamp()}`,
    `- **阈值**: ${THRESHOLD} 分`,
    `- **结果**: ${passed ? '✅ 达标' : '❌ 不达标'} (${totalScore}/${TOTAL_WEIGHT})`,
    hardFailures.length > 0 ? `- **硬门禁失败**: ${hardFailures.join('；')}` : '',
    '',
    '## 评分明细',
    '',
    mdTable(
      ['步骤', '得分', '满分', '权重'],
      tableRows,
    ),
    '',
    '---',
    '',
    '## 详细报告',
    '',
    ...reportSections.map(s => s + '\n'),
    '---',
    '',
    passed ? '**结果: ✅ 达标**' : '**结果: ❌ 不达标**',
    hardFailures.length > 0 ? `\n**硬门禁失败**:\n${hardFailures.map(item => `- ${item}`).join('\n')}` : '',
    '',
  ].join('\n');

  writeText(reportFile, reportContent);
  info(`报告已保存: ${reportFile}`);

  // sidecar JSON 摘要：供 release.mjs aggregate-quality 聚合
  const jsonFile = join(REPORT_DIR, `${reportBase}.json`);
  const summary = {
    sprint: SPRINT_ID,
    level: LEVEL,
    generated_at: timestamp(),
    threshold: THRESHOLD,
    total: totalScore,
    max: TOTAL_WEIGHT,
    passed,
    hard_failures: hardFailures,
    details: details.map(([label, score, max, weight]) => ({ label, score, max, weight })),
  };
  writeText(jsonFile, JSON.stringify(summary, null, 2));
} catch (e) {
  warn(`报告保存失败: ${e.message}`);
}

// ─── 退出 ────────────────────────────────────────────────────────────────────

process.exit(passed ? 0 : 1);
}
