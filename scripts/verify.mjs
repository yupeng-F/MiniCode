#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — 组合式验证工具 (H-08/H-09/H-10)
//
// Agent 端到端自验证：启动 → 健康检查 → 截图 → 日志 → 指标 → 报告
// 每个 phase 可独立运行，结果汇总为 Markdown 验证报告。
//
// 用法:
//   verify.mjs [--config path] [--no-start] [--report-dir path] [--skip-if-recent N] [phase ...]
//
// Phases: preflight docker-up docker-down static health screenshot logs metrics report all(默认)
//
// docker-up:   docker compose down → build → up -d --wait（GOLDEN_RULES G-8 唯一启动入口）
// docker-down: docker compose down -v（清理容器/卷/网络）
// preflight:   compose 服务声明 + 容器健康 + ENV + DB + 外部依赖（带 TTL 幂等缓存）
// =============================================================================

import { spawn } from 'node:child_process';
import { readFileSync as _readFileSync } from 'node:fs';
import {
  C, info, ok, warn, err, fatal,
  run, runCapture, tryRun, hasCmd,
  readText, writeText, findFiles, parseArgs, timestamp, loadYaml,
  existsSync, statSync, mkdirSync, readdirSync, join, dirname, basename,
  projectRoot,
} from './lib/utils.mjs';
import { loadEnvironmentsCompat } from './lib/deploy-config.mjs';

// ─── 默认值（被 verify.config.sh / verify.config.json 覆盖）────────────────

const DEFAULTS = {
  API_URL:              'http://localhost:3000',
  WEB_URL:              'http://localhost:5173',
  HEALTH_ENDPOINT:      '/health',
  READY_ENDPOINT:       '/ready',
  EXECUTION_RUNTIME:    'local',
  COMPOSE_FILE:         'docker-compose.yml',
  DOCKER_REQUIRED_SERVICES: '',
  DOCKER_BUILD_SERVICES: '',
  APP_START_SERVICES:   '',
  MOCK_SERVICE_NAME:    '',
  STARTUP_CMD:          'pnpm dev',
  STARTUP_WAIT:         '15',
  PREFLIGHT_CACHE_TTL_SECONDS: '600',
  SCREENSHOT_PATHS:     '/',
  LOG_QUERY_CMD:        '',
  METRIC_QUERY_CMD:     '',
  LOG_VALIDATE_FIELDS:  'level time msg',
  ENV_FILE:             'src/.env',
  REQUIRED_ENV_VARS:    '',
  DB_CHECK_CMD:         '',
  DB_MIN_TABLES:        '0',
  EXTERNAL_CHECK_CMDS:  '',          // 空格分隔的外部服务连通性检查命令
};

// ─── Config loader ───────────────────────────────────────────────────────────

function loadShellConfig(filePath) {
  const text = readText(filePath);
  const cfg = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    cfg[m[1]] = val;
  }
  return cfg;
}

function loadJsonConfig(filePath) {
  return JSON.parse(readText(filePath));
}

function loadConfig(configFile) {
  const cfg = { ...DEFAULTS };
  if (!existsSync(configFile)) return cfg;

  let overrides;
  if (configFile.endsWith('.json')) {
    overrides = loadJsonConfig(configFile);
  } else {
    overrides = loadShellConfig(configFile);
  }
  Object.assign(cfg, overrides);
  info(`已加载配置: ${configFile}`);
  return cfg;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `\
Harness Verify — Agent 端到端自验证 (H-08/H-09/H-10)

用法:
  verify.mjs [options] [phase ...]

Phases:
  preflight    环境就绪检查（compose 声明 + 容器健康 + DB + ENV）
  docker-up    GOLDEN_RULES G-8 唯一启动入口：down → build → up -d --wait
  docker-down  清理 docker compose 服务（默认保留 volume；--purge 显式销毁）
  static       静态检查（typecheck + lint + audit）
  health       启动服务 + 健康检查
  screenshot   Playwright 截图验证
  logs         日志格式 + 敏感信息检查
  metrics      性能指标查询
  profile-check 项目档案兼容性检查（CICD.md / PROJECT_RULES.md profile）
  all          运行所有 phase（默认）

Options:
  --config <path>          验证配置文件（默认: verify.config.sh）
  --report-dir <path>      报告输出目录（默认: .harness/verify-reports）
  --no-start               不自动启动服务
  --skip-if-recent <sec>   preflight 在最近 N 秒内成功过且关键文件未变更则跳过
  --purge                  docker-down 时同时销毁 volume（默认保留数据）
  --help                   显示帮助

示例:
  verify.mjs                          # 运行全部 phase
  verify.mjs health screenshot        # 仅健康检查 + 截图
  verify.mjs --no-start health        # 假设服务已在运行
  verify.mjs --config staging.config.sh health  # 使用自定义配置

配置文件 (verify.config.sh / verify.config.json):
  API_URL, WEB_URL, HEALTH_ENDPOINT, STARTUP_CMD,
  SCREENSHOT_PATHS, LOG_QUERY_CMD, METRIC_QUERY_CMD,
  EXTERNAL_CHECK_CMDS`;

const { flags, options, positional } = parseArgs(process.argv.slice(2), {
  flags: ['--no-start', '--help', '--purge'],
  options: ['--config', '--report-dir', '--skip-if-recent'],
});

if (flags.has('--help')) {
  console.log(HELP);
  process.exit(0);
}

const CONFIG_FILE = options.get('--config') ?? 'verify.config.sh';
const REPORT_DIR  = options.get('--report-dir') ?? '.harness/verify-reports';
const AUTO_START  = !flags.has('--no-start');
const PHASES      = positional.length > 0 ? positional : ['all'];

const CFG = loadConfig(CONFIG_FILE);
mkdirSync(REPORT_DIR, { recursive: true });

/* Verify script thresholds, limits, and exit codes are centralized here. */
const HTTP_TIMEOUT_MS = 10_000;
const LATENCY_PRECISION_DIGITS = 3;
const COMMAND_PREVIEW_CHARS = 60;
const OUTPUT_PREVIEW_CHARS = 200;
const DEFAULT_STARTUP_WAIT_SECONDS = 15;
const LOG_SAMPLE_LINE_LIMIT = 5;
const REPORT_LOG_LINE_LIMIT = 20;
const REPORT_TIMESTAMP_LENGTH = 15;
const SIGINT_EXIT_CODE = 130;
const SIGTERM_EXIT_CODE = 143;
const MAX_PROCESS_EXIT_CODE = 125;
/* end of centralized literals */

// ─── State ───────────────────────────────────────────────────────────────────

const RESULTS  = [];
let   FAILURES = 0;
let   SERVICE_PID = null;
let   serviceProcess = null;
let   SERVICE_RUNTIME = 'local';

function pass(msg) { ok(msg);   RESULTS.push(`✅ ${msg}`); }
function fail(msg) { err(msg);  RESULTS.push(`❌ ${msg}`); FAILURES++; }
function warnR(msg){ warn(msg); RESULTS.push(`⚠️  ${msg}`); }

// ─── Utility ─────────────────────────────────────────────────────────────────

function hasPlaywright() {
  if (!hasCmd('npx')) return false;
  const { ok: isOk } = tryRun('npx playwright --version');
  return isOk;
}

function sleep(seconds) {
  return new Promise(r => setTimeout(r, seconds * 1000));
}

function splitWords(value) {
  return String(value || '').split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function isDockerRuntime() {
  return CFG.EXECUTION_RUNTIME === 'docker';
}

function getComposeServices() {
  const composeFile = CFG.COMPOSE_FILE || 'docker-compose.yml';
  const { ok: isOk, stdout } = tryRun(`docker compose -f "${composeFile}" config --services`);
  if (!isOk) {
    return [];
  }
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function getRequiredDockerServices() {
  return splitWords(CFG.DOCKER_REQUIRED_SERVICES);
}

function getDockerBuildServices() {
  const services = splitWords(CFG.DOCKER_BUILD_SERVICES);
  return services.length > 0 ? services : getAppStartServices();
}

function getComposeServiceDefinitions() {
  try {
    const doc = loadYaml(CFG.COMPOSE_FILE || 'docker-compose.yml');
    return doc?.services && typeof doc.services === 'object' ? doc.services : {};
  } catch {
    return {};
  }
}

function getExpectedContainerNames() {
  const serviceDefs = getComposeServiceDefinitions();
  return getAppStartServices().map((service) => serviceDefs?.[service]?.container_name || service);
}

const PREFLIGHT_CACHE_FILE = '.harness/preflight.last-pass.json';

// 缓存键包含关键文件 mtime — 任意一个文件变更立即失效
function getPreflightFingerprint() {
  const watchedFiles = [
    CONFIG_FILE,
    CFG.ENV_FILE,
    CFG.COMPOSE_FILE,
    'package.json',
    'pnpm-lock.yaml',
  ].filter(Boolean);
  const mtimes = {};
  for (const file of watchedFiles) {
    try {
      mtimes[file] = statSync(file).mtimeMs;
    } catch {
      mtimes[file] = 0;
    }
  }
  return {
    config: CONFIG_FILE,
    runtime: CFG.EXECUTION_RUNTIME || 'local',
    mtimes,
  };
}

function fingerprintsMatch(a, b) {
  if (!a || !b) return false;
  if (a.config !== b.config || a.runtime !== b.runtime) return false;
  const aKeys = Object.keys(a.mtimes || {});
  const bKeys = Object.keys(b.mtimes || {});
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a.mtimes[k] === b.mtimes[k]);
}

function readPreflightCache() {
  if (!existsSync(PREFLIGHT_CACHE_FILE)) return null;
  try {
    return JSON.parse(readText(PREFLIGHT_CACHE_FILE));
  } catch {
    return null;
  }
}

function writePreflightCache() {
  mkdirSync('.harness', { recursive: true });
  writeText(PREFLIGHT_CACHE_FILE, `${JSON.stringify({
    timestamp: Date.now(),
    fingerprint: getPreflightFingerprint(),
  }, null, 2)}\n`);
}

function shouldSkipPreflight() {
  const ttlSec = parseInt(options.get('--skip-if-recent') ?? '0', 10);
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) return false;
  const cache = readPreflightCache();
  if (!cache) return false;
  if (!fingerprintsMatch(cache.fingerprint, getPreflightFingerprint())) return false;
  const ageSec = (Date.now() - cache.timestamp) / 1000;
  return ageSec <= ttlSec;
}

function getAppStartServices() {
  const services = splitWords(CFG.APP_START_SERVICES);
  return services.length > 0 ? services : getRequiredDockerServices();
}

/** Perform an HTTP check on a URL. Returns { status, latency }. */
async function httpCheck(url) {
  try {
    const start = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const latency = ((Date.now() - start) / 1000).toFixed(LATENCY_PRECISION_DIGITS);
    return { status: String(res.status), latency };
  } catch {
    // Fall back to curl
    const statusResult = tryRun(`curl -sf -o /dev/null -w "%{http_code}" --max-time 10 "${url}"`);
    const latencyResult = tryRun(`curl -sf -o /dev/null -w "%{time_total}" --max-time 10 "${url}"`);
    return {
      status: statusResult.ok ? statusResult.stdout.trim() : '000',
      latency: latencyResult.ok ? latencyResult.stdout.trim() : '0',
    };
  }
}

function shouldRun(phase) {
  if (PHASES.includes(phase)) return true;
  // docker-up / docker-down 是显式入口，不属于 'all'
  if (phase === 'docker-up' || phase === 'docker-down') return false;
  return PHASES.includes('all');
}

// ─── Phase: preflight ────────────────────────────────────────────────────────

function phasePreflight() {
  info('━━━ Phase: preflight（环境就绪检查）━━━');

  if (shouldSkipPreflight()) {
    pass(`Preflight: 最近 ${options.get('--skip-if-recent')}s 内已通过且关键文件未变更，跳过`);
    return;
  }

  const failuresBefore = FAILURES;
  let PREFLIGHT_HAS_WARNING = false;

  // 1. Docker compose 服务声明 + 容器健康
  if (isDockerRuntime()) {
    if (!hasCmd('docker')) {
      fail('Preflight: docker 不可用 — Docker 运行模式必需');
    } else {
      const definedServices = getComposeServices();
      const requiredServices = getRequiredDockerServices();
      const missingServices = requiredServices.filter((service) => !definedServices.includes(service));
      if (requiredServices.length === 0) {
        fail('Preflight: DOCKER_REQUIRED_SERVICES 未配置 — Docker 运行模式必须声明 API/Web/Mock 服务');
      } else if (missingServices.length === 0) {
        pass(`Preflight: Docker Compose 已声明必需服务（${requiredServices.join(', ')}）`);
      } else {
        fail(`Preflight: Docker Compose 缺少必需服务 → ${missingServices.join(', ')}`);
        info(`  在 ${CFG.COMPOSE_FILE} 中补齐后重试`);
      }

      // Mock 独立声明：Docker 模式默认强制要求；纯后端/基础设施 Sprint 可显式 opt-out：
      // verify.config.sh 设置 MOCK_SERVICE_NAME=NONE
      const mockServiceName = CFG.MOCK_SERVICE_NAME?.trim();
      if (mockServiceName === 'NONE') {
        pass('Preflight: 当前 Sprint 已显式声明无需 Mock 服务（MOCK_SERVICE_NAME=NONE）');
      } else if (!mockServiceName) {
        fail('Preflight: MOCK_SERVICE_NAME 未配置 — Docker 运行模式要求声明 Mock 服务名（或 NONE 显式 opt-out）');
      } else if (definedServices.includes(mockServiceName)) {
        pass(`Preflight: Mock 服务已独立声明（${mockServiceName}）`);
      } else {
        fail(`Preflight: Mock 服务 ${mockServiceName} 未在 ${CFG.COMPOSE_FILE} 中声明`);
      }

      // 容器运行健康
      const { ok: isOk, stdout } = tryRun(`docker compose -f "${CFG.COMPOSE_FILE}" ps --format "{{.Name}} {{.Status}}"`);
      if (!isOk) {
        fail('Preflight: docker compose ps 调用失败');
      } else {
        const lines = stdout.split('\n').filter(l => l.trim());
        const unhealthy = lines.filter(l => !/healthy|running/i.test(l));
        if (lines.length === 0) {
          warnR('Preflight: 当前无运行中的容器 — 运行 verify.mjs docker-up 启动');
          PREFLIGHT_HAS_WARNING = true;
        } else if (unhealthy.length === 0) {
          pass(`Preflight: Docker 服务健康（${lines.length} 个容器）`);
        } else {
          fail('Preflight: Docker 服务异常 — 运行 verify.mjs docker-up 重建');
          for (const line of unhealthy) info(`  ${line}`);
        }
      }
    }
  } else if (hasCmd('docker')) {
    const { ok: isOk, stdout } = tryRun('docker compose ps --format "{{.Name}} {{.Status}}"');
    if (isOk) {
      const unhealthy = stdout.split('\n')
        .filter(l => l.trim())
        .filter(l => !/healthy/i.test(l));
      if (unhealthy.length === 0) {
        pass('Preflight: Docker 中间件全部 healthy');
      } else {
        fail('Preflight: Docker 中间件异常 — 运行 docker compose up -d 启动');
        for (const line of unhealthy) info(`  ${line}`);
      }
    } else {
      fail('Preflight: Docker 中间件异常 — 运行 docker compose up -d 启动');
    }
  } else {
    fail('Preflight: docker 不可用');
  }

  // 2. 环境变量文件 + 必需变量
  if (CFG.REQUIRED_ENV_VARS) {
    if (existsSync(CFG.ENV_FILE)) {
      pass(`Preflight: ${CFG.ENV_FILE} 存在`);
      const envContent = readText(CFG.ENV_FILE);
      const vars = CFG.REQUIRED_ENV_VARS.split(/\s+/).filter(Boolean);
      const missing = [];
      for (const v of vars) {
        const m = envContent.match(new RegExp(`^${v}=(.*)$`, 'm'));
        const val = m ? m[1].trim() : '';
        if (!val || val.startsWith('your-') || val.startsWith('sk-your-')) {
          missing.push(v);
        }
      }
      if (missing.length === 0) {
        pass('Preflight: 必需环境变量已配置');
      } else {
        fail(`Preflight: 以下环境变量未配置 → ${missing.join(' ')}`);
        info(`  编辑 ${CFG.ENV_FILE} 填写真实值后重新运行`);
      }
    } else {
      fail(`Preflight: ${CFG.ENV_FILE} 不存在 — 复制 ${CFG.ENV_FILE}.sample 并填写配置`);
    }
  }

  // 3. 数据库表就绪
  if (CFG.DB_CHECK_CMD) {
    const { stdout } = tryRun(CFG.DB_CHECK_CMD);
    const tableCount = parseInt(stdout.trim(), 10) || 0;
    const minTables = parseInt(CFG.DB_MIN_TABLES, 10) || 0;
    if (tableCount >= minTables) {
      pass(`Preflight: 数据库已初始化（${tableCount} 张表）`);
    } else {
      fail(`Preflight: 数据库表不足（${tableCount}/${minTables}）`);
    }
  }

  // 4. 外部服务连通性
  if (CFG.EXTERNAL_CHECK_CMDS) {
    const cmds = CFG.EXTERNAL_CHECK_CMDS.split('|').map(s => s.trim()).filter(Boolean);
    for (const cmd of cmds) {
      const { ok: isOk, stdout } = tryRun(cmd);
      if (isOk) {
        pass(`Preflight: 外部服务检查通过 — ${cmd.slice(0, COMMAND_PREVIEW_CHARS)}`);
      } else {
        fail(`Preflight: 外部服务不可达 — ${cmd.slice(0, COMMAND_PREVIEW_CHARS)}`);
        if (stdout) info(`  输出: ${stdout.slice(0, OUTPUT_PREVIEW_CHARS)}`);
      }
    }
  }

  if (FAILURES === failuresBefore && !PREFLIGHT_HAS_WARNING) {
    writePreflightCache();
  }
}

// ─── Phase: docker-up / docker-down ──────────────────────────────────────────

// 检查 APP_START_SERVICES 中所有服务是否都处于 healthy（或 running 且无 healthcheck）
function areExpectedServicesHealthy() {
  if (!hasCmd('docker')) return false;
  const expected = getAppStartServices();
  if (expected.length === 0) return false;
  const composeFile = CFG.COMPOSE_FILE;
  const { ok: psOk, stdout } = tryRun(
    `docker compose -f "${composeFile}" ps --format "{{.Service}}\t{{.State}}\t{{.Health}}"`,
  );
  const statusByService = new Map();
  if (psOk && stdout.trim()) {
    for (const line of stdout.trim().split('\n')) {
      const [svc, state, health] = line.split('\t');
      if (!svc) continue;
      statusByService.set(svc, { state: state || '', health: health || '' });
    }
  }
  const composeMatches = expected.every((svc) => {
    const s = statusByService.get(svc);
    if (!s) return false;
    if (s.state !== 'running') return false;
    // health 字段可能为空（无 healthcheck）— 视为 healthy
    return s.health === 'healthy' || s.health === '';
  });
  if (composeMatches) return true;

  const expectedContainers = getExpectedContainerNames();
  if (expectedContainers.length === 0) return false;
  const { ok: dockerPsOk, stdout: dockerPsStdout } = tryRun(
    'docker ps -a --format "{{.Names}}\t{{.State}}\t{{.Status}}"',
  );
  if (!dockerPsOk || !dockerPsStdout.trim()) return false;
  const containerStatus = new Map();
  for (const line of dockerPsStdout.trim().split('\n')) {
    const [name, state, status] = line.split('\t');
    if (!name) continue;
    containerStatus.set(name, { state: state || '', status: status || '' });
  }
  return expectedContainers.every((name) => {
    const entry = containerStatus.get(name);
    if (!entry || entry.state !== 'running') return false;
    if (entry.status.includes('(unhealthy)') || entry.status.includes('(starting)')) return false;
    return true;
  });
}

function phaseDockerUp({ strict = true } = {}) {
  info('━━━ Phase: docker-up（重建并启动 Docker 服务）━━━');
  if (!isDockerRuntime()) {
    const record = strict ? fail : warnR;
    record('Docker-up: EXECUTION_RUNTIME != docker，跳过');
    return;
  }
  if (!hasCmd('docker')) {
    const record = strict ? fail : warnR;
    record('Docker-up: docker 不可用');
    return;
  }

  const composeFile = CFG.COMPOSE_FILE;
  const buildServices = getDockerBuildServices();
  const startServices = getAppStartServices();
  if (startServices.length === 0) {
    const record = strict ? fail : warnR;
    record('Docker-up: APP_START_SERVICES / DOCKER_REQUIRED_SERVICES 未配置');
    return;
  }

  info(`Docker-up: docker compose -f "${composeFile}" down`);
  const downResult = tryRun(`docker compose -f "${composeFile}" down`);
  if (!downResult.ok) {
    warnR('Docker-up: down 阶段非 0 退出（可能本来就未运行），继续 build');
  }

  if (buildServices.length > 0) {
    const buildCmd = `docker compose -f "${composeFile}" build ${buildServices.join(' ')}`;
    info(`Docker-up: ${buildCmd}`);
    const { ok: isOk } = tryRun(buildCmd);
    if (!isOk) {
      const record = strict ? fail : warnR;
      record(`Docker-up: 镜像构建失败 — ${buildServices.join(', ')}`);
      return;
    }
    pass(`Docker-up: 镜像构建完成（${buildServices.join(', ')}）`);
  }

  const upCmd = `docker compose -f "${composeFile}" up -d --wait ${startServices.join(' ')}`;
  info(`Docker-up: ${upCmd}`);
  const { ok: isOk, stderr } = tryRun(upCmd);
  if (!isOk) {
    const record = strict ? fail : warnR;
    record(`Docker-up: 启动失败或健康检查超时 — ${startServices.join(', ')}`);
    if (stderr) info(`  ${stderr.slice(0, OUTPUT_PREVIEW_CHARS)}`);
    return;
  }

  SERVICE_RUNTIME = 'docker';
  pass(`Docker-up: 服务已启动并 healthy（${startServices.join(', ')}）`);
}

function phaseDockerDown() {
  info('━━━ Phase: docker-down（清理 Docker 服务）━━━');
  if (!hasCmd('docker')) {
    warnR('Docker-down: docker 不可用，跳过');
    return;
  }
  const composeFile = CFG.COMPOSE_FILE;
  // 默认仅停止/移除容器，保留数据 volume；显式 --purge 时才 -v
  const purgeVolumes = flags.has('--purge');
  const cmd = `docker compose -f "${composeFile}" down${purgeVolumes ? ' -v' : ''}`;
  info(`Docker-down: ${cmd}${purgeVolumes ? '（含 volume 销毁）' : '（保留 volume）'}`);
  const { ok: isOk } = tryRun(cmd);
  if (isOk) {
    pass(`Docker-down: 清理完成${purgeVolumes ? '（volume 已销毁）' : ''}`);
  } else {
    fail('Docker-down: 清理失败');
  }
}

// ─── Phase: static ───────────────────────────────────────────────────────────

function phaseStatic() {
  info('━━━ Phase: static（静态检查）━━━');
  const cmds = ['pnpm typecheck', 'pnpm lint', 'pnpm audit --audit-level=high'];
  for (const cmd of cmds) {
    if (!hasCmd('pnpm')) {
      warnR(`Static: pnpm 不可用，跳过 ${cmd}`);
      continue;
    }
    const { ok: isOk } = tryRun(cmd);
    if (isOk) {
      pass(`Static: ${cmd}`);
    } else {
      fail(`Static: ${cmd}`);
    }
  }
}

// ─── Phase: health ───────────────────────────────────────────────────────────

function startService() {
  if (!AUTO_START) return;

  if (isDockerRuntime()) {
    // 幂等：先检查目标服务是否已 healthy；是则跳过启动，避免无谓的 down/build/up。
    // 强制重建请显式运行 `verify.mjs docker-up`（G-8 唯一启动入口）。
    if (areExpectedServicesHealthy()) {
      pass('Docker: 目标服务已全部 healthy，跳过启动');
      return;
    }
    phaseDockerUp({ strict: false });
    return;
  }

  info(`启动服务: ${CFG.STARTUP_CMD}`);
  const parts = CFG.STARTUP_CMD.split(/\s+/);
  const child = spawn(parts[0], parts.slice(1), {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  serviceProcess = child;
  SERVICE_PID = child.pid;
  SERVICE_RUNTIME = 'local';

  // Record PID for external cleanup
  mkdirSync(REPORT_DIR, { recursive: true });
  writeText(join(REPORT_DIR, '.pids'), `${SERVICE_PID}\n`);
  mkdirSync('.harness', { recursive: true });
  const pidsFile = '.harness/pids';
  const existing = existsSync(pidsFile) ? readText(pidsFile) : '';
  writeText(pidsFile, existing + `${SERVICE_PID}\n`);

  info(`服务 PID: ${SERVICE_PID} — 等待 ${CFG.STARTUP_WAIT}s`);
}

function stopService() {
  if (SERVICE_RUNTIME === 'docker') {
    info('Docker 服务保持运行，供联调 / E2E / UI 走查继续复用');
    return;
  }
  if (SERVICE_PID != null) {
    try {
      process.kill(-SERVICE_PID);   // Kill process group (detached)
    } catch {
      try { process.kill(SERVICE_PID); } catch { /* already exited */ }
    }
    info(`服务已停止 (PID ${SERVICE_PID})`);
    SERVICE_PID = null;
    serviceProcess = null;
  }
}

async function checkEndpoint(label, url, expect = '200') {
  const { status, latency } = await httpCheck(url);
  if (status === expect) {
    pass(`Health: ${label} → ${status} (${latency}s)`);
  } else {
    fail(`Health: ${label} → ${status} (期望 ${expect})`);
  }
}

async function phaseHealth() {
  info('━━━ Phase: health（健康检查）━━━');
  startService();
  await sleep(parseInt(CFG.STARTUP_WAIT, 10) || DEFAULT_STARTUP_WAIT_SECONDS);
  if (isDockerRuntime() && !areExpectedServicesHealthy()) {
    fail('Health: Docker 目标服务未全部 healthy');
  } else if (isDockerRuntime()) {
    pass('Health: Docker 目标服务全部 healthy');
  }
  await checkEndpoint(`API ${CFG.HEALTH_ENDPOINT}`, `${CFG.API_URL}${CFG.HEALTH_ENDPOINT}`);
  if (CFG.READY_ENDPOINT) {
    await checkEndpoint(`API ${CFG.READY_ENDPOINT}`, `${CFG.API_URL}${CFG.READY_ENDPOINT}`);
  }
  await checkEndpoint('Web 首页', CFG.WEB_URL);
}

// ─── Phase: screenshot ───────────────────────────────────────────────────────

function phaseScreenshot() {
  info('━━━ Phase: screenshot（截图验证）━━━');

  const screenshotDir = join(REPORT_DIR, 'screenshots');
  mkdirSync(screenshotDir, { recursive: true });

  if (!hasPlaywright()) {
    warnR('Screenshot: Playwright CLI 不可用，跳过截图');
    warn('  安装: npx playwright install chromium');
    return;
  }

  const paths = CFG.SCREENSHOT_PATHS.split(/\s+/).filter(Boolean);
  for (const p of paths) {
    const url = `${CFG.WEB_URL}${p}`;
    const filename = p.replace(/[^a-zA-Z0-9]/g, '_');
    const outfile = join(screenshotDir, `${filename}.png`);

    const { ok: isOk } = tryRun(`npx playwright screenshot --browser chromium "${url}" "${outfile}"`);
    if (isOk) {
      pass(`Screenshot: ${p} → ${outfile}`);
    } else {
      fail(`Screenshot: ${p} 截图失败`);
    }
  }
}

// ─── Phase: logs ─────────────────────────────────────────────────────────────

function phaseLogs() {
  info('━━━ Phase: logs（日志验证）━━━');

  if (!CFG.LOG_QUERY_CMD) {
    warnR('Logs: LOG_QUERY_CMD 未配置，跳过');
    return;
  }

  const { stdout: logOutput } = tryRun(CFG.LOG_QUERY_CMD);
  if (!logOutput || !logOutput.trim()) {
    fail('Logs: 查询无输出');
    return;
  }

  pass(`Logs: 查询有输出 (${logOutput.length} bytes)`);

  // Check JSON structured format (first 5 lines)
  const first5 = logOutput.split('\n').slice(0, LOG_SAMPLE_LINE_LIMIT).filter(l => l.trim());
  let allJson = true;
  for (const line of first5) {
    try { JSON.parse(line); } catch { allJson = false; break; }
  }
  if (first5.length > 0 && allJson) {
    pass('Logs: JSON 结构化格式');
  } else {
    warnR('Logs: 非 JSON 格式（或前 5 行非 JSON）');
  }

  // Check required fields
  const fields = CFG.LOG_VALIDATE_FIELDS.split(/\s+/).filter(Boolean);
  const first5Text = first5.join('\n');
  for (const field of fields) {
    if (first5Text.includes(`"${field}"`)) {
      pass(`Logs: 包含字段 '${field}'`);
    } else {
      warnR(`Logs: 缺少字段 '${field}'`);
    }
  }

  // Check sensitive info leaks
  const sensitiveRe = /(password|secret|api.?key|token)["']\s*:\s*["'][^"']{8,}/i;
  if (sensitiveRe.test(logOutput)) {
    fail('Logs: 检测到疑似敏感信息泄露');
  } else {
    pass('Logs: 无明显敏感信息泄露');
  }

  // Save log sample
  const sample = logOutput.split('\n').slice(0, REPORT_LOG_LINE_LIMIT).join('\n');
  writeText(join(REPORT_DIR, 'log-sample.txt'), sample + '\n');
}

// ─── Phase: metrics ──────────────────────────────────────────────────────────

function phaseMetrics() {
  info('━━━ Phase: metrics（指标验证）━━━');

  if (!CFG.METRIC_QUERY_CMD) {
    warnR('Metrics: METRIC_QUERY_CMD 未配置，跳过');
    return;
  }

  const { stdout: metricOutput } = tryRun(CFG.METRIC_QUERY_CMD);
  if (!metricOutput || !metricOutput.trim()) {
    fail('Metrics: 查询无输出');
    return;
  }

  pass('Metrics: 查询有输出');
  writeText(join(REPORT_DIR, 'metrics-sample.txt'), metricOutput);
}

// ─── Phase: report ───────────────────────────────────────────────────────────

function phaseReport() {
  const ts = new Date().toISOString().replace('T', '-').replace(/:/g, '').slice(0, REPORT_TIMESTAMP_LENGTH);
  const reportPath = join(REPORT_DIR, `verify-${ts}.md`);
  const total = RESULTS.length;
  const passed = total - FAILURES;
  const conclusion = FAILURES === 0 ? '✅ 全部通过' : `❌ ${FAILURES} 项失败`;
  const now = timestamp();

  let content = `# 验证报告

| 字段 | 值 |
|------|----|
| 时间 | ${now} |
| 配置 | ${CONFIG_FILE} |
| 结论 | ${conclusion} |

## 摘要

通过: ${passed} / ${total}

## 明细

`;
  for (const r of RESULTS) {
    content += `- ${r}\n`;
  }

  // Append screenshot list
  const ssDir = join(REPORT_DIR, 'screenshots');
  if (existsSync(ssDir)) {
    try {
      const pngs = readdirSync(ssDir).filter(f => f.endsWith('.png'));
      if (pngs.length > 0) {
        content += '\n## 截图\n\n';
        for (const img of pngs) {
          content += `- ${img}\n`;
        }
      }
    } catch { /* ignore */ }
  }

  writeText(reportPath, content);

  info('━━━ 验证报告 ━━━');
  info(`报告: ${reportPath}`);
  info(`通过: ${passed} / ${total}`);
  if (FAILURES > 0) {
    fail(`失败: ${FAILURES} 项`);
  } else {
    pass('全部通过');
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup() {
  stopService();
}

// ─── Phase: profile-check（CICD.md）────────────────────────────────────
// 校验当前项目档案与发布要求一致：
//   1. PROJECT_RULES.md / package.json 至少存在一个（项目存在性）
//   2. config/deploy.yml 可解析且包含 test/prod 两键（兼容 legacy environments.yml）
//   3. 读取 deploy config 的 compose_file，对 deploy/test|prod 执行
//      docker compose config --services；解析失败 / 0 服务 / 非 dev 含 mock 直接失败
function getProfileTargets(profile, envs) {
  if (!profile) return ['test', 'prod'];
  if (!envs[profile]) return [];
  return [profile];
}

function getComposeConfigServices(composeFile) {
  const envPrefix = [
    'QWCHAT_API_IMAGE_REPOSITORY=registry.example.invalid/qwchat-api',
    'QWCHAT_WEB_IMAGE_REPOSITORY=registry.example.invalid/qwchat-web',
    'QWCHAT_IMAGE_TAG=profile-check',
  ].join(' ');
  return tryRun(`${envPrefix} docker compose -f "${composeFile}" config --services`);
}

function phaseProfileCheck() {
  info('━━━ Phase: profile-check（项目档案兼容性）━━━');
  let failed = 0;
  const must = ['PROJECT_RULES.md', 'package.json', 'pyproject.toml', 'go.mod'];
  if (!must.some(f => existsSync(f))) {
    err('未发现项目根标识文件（PROJECT_RULES.md / package.json / pyproject.toml / go.mod）');
    failed++;
  } else {
    ok('项目根标识文件存在');
  }
  const envConfigPath = existsSync('config/deploy.yml') ? 'config/deploy.yml' : 'config/environments.yml';
  if (!existsSync(envConfigPath)) {
    err('config/deploy.yml 不存在（legacy config/environments.yml 也不存在）');
    failed++;
  } else {
    try {
      const env = loadEnvironmentsCompat();
      const envs = (env && env.environments) || {};
      const missing = ['test', 'prod'].filter(k => !envs[k]);
      if (missing.length) {
        err(`${envConfigPath} environments 缺少：${missing.join(', ')}`);
        failed++;
      } else {
        ok(`${envConfigPath} environments 完整（test/prod）`);
      }
      const profile = process.env.HARNESS_VERIFY_PROFILE;
      const targets = getProfileTargets(profile, envs);
      if (profile && targets.length === 0) {
        err(`HARNESS_VERIFY_PROFILE=${profile} 未在 ${envConfigPath} 中声明`);
        failed++;
      }
      for (const target of targets) {
        const composeFile = envs[target]?.compose_file;
        if (!composeFile || !existsSync(composeFile)) {
          err(`${target}: compose_file 不存在或不可读（${composeFile || '未配置'}）`);
          failed++;
          continue;
        }
        info(`校验 ${target} 部署资产：${composeFile}`);
        const r = getComposeConfigServices(composeFile);
        if (!r.ok) {
          err(`${target}: docker compose config --services 失败\n${(r.stderr || r.stdout || '').trim()}`);
          failed++;
          continue;
        }
        const services = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
        if (services.length === 0) {
          err(`${target}: docker compose config --services 返回 0 个服务`);
          failed++;
          continue;
        }
        const mocks = services.filter(s => /mock/i.test(s));
        if (target !== 'dev' && mocks.length > 0) {
          err(`${target}: 非 dev 部署资产不允许 mock 服务，发现：${mocks.join(', ')}`);
          failed++;
          continue;
        }
        ok(`${target}: 部署资产可解析（${services.length} 个服务）`);
      }
    } catch (e) {
      err(`${envConfigPath} 解析失败: ${e.message}`);
      failed++;
    }
  }

  if (failed > 0) FAILURES += failed;
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(SIGINT_EXIT_CODE); });
process.on('SIGTERM', () => { cleanup(); process.exit(SIGTERM_EXIT_CODE); });

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log();
  info('Harness Verify — 开始验证');
  info(`配置: ${CONFIG_FILE} | 报告: ${REPORT_DIR}`);
  console.log();

  if (shouldRun('preflight'))   phasePreflight();
  if (shouldRun('docker-up'))   phaseDockerUp();
  if (shouldRun('docker-down')) phaseDockerDown();
  if (shouldRun('static'))      phaseStatic();
  if (shouldRun('health'))      await phaseHealth();
  if (shouldRun('screenshot'))  phaseScreenshot();
  if (shouldRun('logs'))        phaseLogs();
  if (shouldRun('metrics'))     phaseMetrics();
  if (shouldRun('profile-check')) phaseProfileCheck();

  console.log();
  phaseReport();

  // Exit with failure count (capped at 125 to stay in valid range)
  process.exit(Math.min(FAILURES, MAX_PROCESS_EXIT_CODE));
}

main();
