#!/usr/bin/env node

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { err, info, ok, parseArgs, writeText } from './lib/utils.mjs';

/* UI audit defaults centralize viewport and timeout literals. */
const DEFAULT_REPORT_PATH = 'coverage/ui-audit.json';
const DEFAULT_API_URL = 'http://localhost:3000';
const DEFAULT_WEB_URL = 'http://localhost:5173';
const DEFAULT_SCREENSHOT_ROOT = 'coverage/ui-audit';
const READY_SELECTOR_TIMEOUT_MS = 10_000;
const POST_READY_SETTLE_MS = 1_200;
const ACTION_SETTLE_MS = 800;
const DEFAULT_LAYOUT_TOLERANCE_PX = 12;
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const MOBILE_VIEWPORT = { width: 375, height: 812 };
/* end of centralized literals */

const { flags, options } = parseArgs(process.argv.slice(2), {
  options: ['--sprint', '--report-path', '--api-url', '--web-url', '--screenshot-dir'],
});

if (flags.has('--help')) {
  console.log(`用法: ui-audit.mjs --sprint <N-name> [--report-path path] [--api-url url] [--web-url url] [--screenshot-dir path]
  --sprint:         Sprint 标识（必填），用于加载该 Sprint 的 UI 契约
  --report-path:    UI 审核 JSON 路径（默认: coverage/ui-audit.json）
  --api-url:        API 地址（默认: verify.config.sh / 环境变量 / http://localhost:3000）
  --web-url:        Web 地址（默认: verify.config.sh / 环境变量 / http://localhost:5173）
  --screenshot-dir: 截图目录（默认: coverage/ui-audit）`);
  process.exit(0);
}

const sprintId = options.get('--sprint');
if (!sprintId) {
  err('--sprint 参数必填。用法: node scripts/ui-audit.mjs --sprint 9-dashboard-summary-polish');
  process.exit(1);
}

const reportPath = options.get('--report-path') || DEFAULT_REPORT_PATH;
const screenshotRoot = options.get('--screenshot-dir') || DEFAULT_SCREENSHOT_ROOT;
const apiBase = normalizeUrl(options.get('--api-url') || process.env.API_URL || DEFAULT_API_URL);
const webBase = normalizeUrl(options.get('--web-url') || process.env.WEB_URL || DEFAULT_WEB_URL);

info('==========================================');
info(' UI Fidelity Audit');
info(` Sprint: ${sprintId}`);
info(` API: ${apiBase}`);
info(` WEB: ${webBase}`);
info('==========================================');
info('提示: 若 WEB 指向 Docker 容器且本地 web/ 有未发布修改,');
info('      请先执行 `docker compose up -d --build web` 以确保审核基于最新构建。');
info('      Buildkit 缓存命中时,旧 dist 可能与本次代码失配。');
info('==========================================');

try {
  const projectModule = await loadProjectContractsModule();
  if (!projectModule) {
    err(`未找到 lint/ui-contracts.mjs — UI 审核必须由项目侧声明契约。
若当前 Sprint 确实无 UI 变更，请在 lint/ui-contracts.mjs 中显式导出：
  export const required = false;
  export async function createAuditPlan() { return { required: false, reason: '本 Sprint 无 UI 变更' }; }`);
    process.exit(1);
  }
  if (projectModule.required === false && typeof projectModule.createAuditPlan !== 'function') {
    const report = {
      sprintId,
      collectedAt: new Date().toISOString(),
      environment: { apiBase, webBase },
      mode: 'not-required',
      required: false,
      reason: 'lint/ui-contracts.mjs 显式声明 required = false',
      pages: [],
      passed: true,
    };
    writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    ok(`UI 审核记为 not-required（项目显式声明）: ${reportPath}`);
    process.exit(0);
  }

  const auth = await login();
  const runtime = await buildRuntime(auth.token, projectModule);
  const helpers = {
    comparePresence,
    compareCount,
    compareStyle,
    compareTextList,
    compareMetric,
    DESKTOP_VIEWPORT,
    MOBILE_VIEWPORT,
  };
  const auditPlan = await projectModule.createAuditPlan({
    sprintId,
    runtime,
    helpers,
    apiBase,
    webBase,
  });
  if (auditPlan.required === false) {
    const report = {
      sprintId,
      collectedAt: new Date().toISOString(),
      environment: { apiBase, webBase },
      mode: 'not-required',
      required: false,
      reason: auditPlan.reason || '当前 Sprint 无用户可见 UI 范围',
      pages: [],
      passed: true,
    };
    writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    ok(`UI 审核已记录为 not-required: ${reportPath}`);
    process.exit(0);
  }

  const contracts = Array.isArray(auditPlan.contracts) ? auditPlan.contracts : [];
  if (contracts.length === 0) {
    throw new Error(auditPlan.reason || `Sprint ${sprintId} 尚未在 lint/ui-contracts.mjs 声明 UI 原型对照计划`);
  }

  const screenshotDir = join(screenshotRoot, sprintId);
  mkdirSync(screenshotDir, { recursive: true });

  const pages = [];
  for (const contract of contracts) {
    pages.push(await auditContract(contract, auth, screenshotDir));
  }

  const passed = pages.length > 0 && pages.every((page) => page.passed);
  const report = {
    sprintId,
    collectedAt: new Date().toISOString(),
    environment: {
      apiBase,
      webBase,
    },
    mode: 'prototype-parity',
    required: true,
    pages,
    passed,
  };

  writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const page of pages) {
    info(`${page.name}: ${page.passed ? 'PASS' : 'FAIL'} (${page.checks.filter((check) => check.passed).length}/${page.checks.length})`);
  }

  if (passed) {
    ok(`UI 审核通过: ${reportPath}`);
    process.exit(0);
  }

  err(`UI 审核未通过，请检查 ${reportPath}`);
  process.exit(1);
} catch (error) {
  err(toErrorMessage(error));
  process.exit(1);
}

async function loadProjectContractsModule() {
  const candidate = resolve(process.cwd(), 'lint/ui-contracts.mjs');
  try {
    const stat = await import('node:fs').then((mod) => mod.promises.stat(candidate));
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  const moduleUrl = pathToFileURL(candidate).href;
  const projectModule = await import(moduleUrl);
  if (typeof projectModule.createAuditPlan !== 'function') {
    throw new Error('lint/ui-contracts.mjs 未导出 createAuditPlan(...) 函数');
  }
  return projectModule;
}

async function buildRuntime(token, projectModule) {
  if (typeof projectModule.resolveAuditUserId === 'function') {
    const userId = await projectModule.resolveAuditUserId({
      sprintId,
      apiBase,
      token,
      fetch: safeFetch,
    });
    return { userId };
  }
  return {};
}

// createAuditPlan 现在由项目通过 lint/ui-contracts.mjs 提供。

async function auditContract(contract, auth, screenshotDir) {
  const browser = await chromium.launch({ headless: true });
  const liveContext = await browser.newContext({
    viewport: contract.viewport,
    deviceScaleFactor: 1,
  });
  const prototypeContext = await browser.newContext({
    viewport: contract.viewport,
    deviceScaleFactor: 1,
  });

  await liveContext.addInitScript(
    ({ token, userJson }) => {
      localStorage.setItem('imchat_auth_token', token);
      localStorage.setItem('imchat_auth_user', userJson);
    },
    { token: auth.token, userJson: JSON.stringify(auth.user) },
  );
  await liveContext.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/auth/')) {
      return route.continue();
    }
    return route.continue({
      headers: {
        ...route.request().headers(),
        authorization: `Bearer ${auth.token}`,
      },
    });
  });

  const prototypePage = await prototypeContext.newPage();
  const livePage = await liveContext.newPage();
  const prototypeScreenshotPath = join(screenshotDir, `${contract.screenshotName.replace(/\.png$/, '')}-prototype.png`);
  const liveScreenshotPath = join(screenshotDir, `${contract.screenshotName.replace(/\.png$/, '')}-live.png`);

  try {
    await openPrototypePage(prototypePage, contract.prototype);
    await openLivePage(livePage, contract.live);

    const checks = [];
    for (const check of contract.checks) {
      checks.push(await check({ prototypePage, livePage }));
    }

    await prototypePage.screenshot({ path: prototypeScreenshotPath, fullPage: true });
    await livePage.screenshot({ path: liveScreenshotPath, fullPage: true });

    return {
      name: contract.name,
      designRef: contract.designRef,
      prototypePath: contract.prototype.path,
      livePath: contract.live.path,
      viewport: contract.viewport,
      prototypeScreenshotPath,
      liveScreenshotPath,
      checks,
      passed: checks.every((check) => check.passed),
    };
  } finally {
    await browser.close();
  }
}

async function openPrototypePage(page, target) {
  await page.goto(pathToFileURL(resolve(target.path)).href, { waitUntil: 'domcontentloaded' });
  await page.locator(target.readySelector).first().waitFor({ state: 'visible', timeout: READY_SELECTOR_TIMEOUT_MS });
  if (typeof target.prepare === 'function') {
    await page.waitForTimeout(POST_READY_SETTLE_MS);
    await target.prepare(page);
    await page.waitForTimeout(ACTION_SETTLE_MS);
  }
  const settledSelector = target.settledSelector || target.readySelector;
  await page.locator(settledSelector).first().waitFor({ state: 'visible', timeout: READY_SELECTOR_TIMEOUT_MS });
  await page.waitForTimeout(POST_READY_SETTLE_MS);
}

async function openLivePage(page, target) {
  await page.goto(`${webBase}${target.path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator(target.readySelector).first().waitFor({ state: 'visible', timeout: READY_SELECTOR_TIMEOUT_MS });
  await page.waitForTimeout(POST_READY_SETTLE_MS);
  if (typeof target.prepare === 'function') {
    await target.prepare(page);
    await page.waitForTimeout(ACTION_SETTLE_MS);
  }
}

// Helpers attach `.kind` and `.label` so static tooling (e.g.
// scripts/check-contract-strength.mjs) can audit contract composition without
// running the browser plan.

function tag(fn, kind, label) {
  fn.kind = kind;
  fn.label = label;
  return fn;
}

function comparePresence(label, prototypeSelector, liveSelector) {
  return tag(async ({ prototypePage, livePage }) => {
    const prototypeCount = await prototypePage.locator(prototypeSelector).count();
    const liveCount = await livePage.locator(liveSelector).count();
    return prototypeCount > 0 && liveCount > 0
      ? pass(label, `原型 ${prototypeCount} / 实现 ${liveCount}`, `原型 ${prototypeCount} / 实现 ${liveCount}`)
      : fail(label, `原型 ${prototypeCount} / 实现 ${liveCount}`, `原型 ${prototypeCount} / 实现 ${liveCount}`);
  }, 'presence', label);
}

function compareCount(label, prototypeSelector, liveSelector) {
  return tag(async ({ prototypePage, livePage }) => {
    const prototypeCount = await prototypePage.locator(prototypeSelector).count();
    const liveCount = await livePage.locator(liveSelector).count();
    return prototypeCount > 0 && prototypeCount === liveCount
      ? pass(label, `数量 = ${prototypeCount}`, `数量 = ${liveCount}`)
      : fail(label, `数量 = ${prototypeCount}`, `数量 = ${liveCount}`);
  }, 'count', label);
}

function compareStyle(label, prototypeSelector, liveSelector, property) {
  return tag(async ({ prototypePage, livePage }) => {
    const prototypeValue = await readStyleValue(prototypePage, prototypeSelector, property);
    const liveValue = await readStyleValue(livePage, liveSelector, property);
    return prototypeValue !== 'ELEMENT_MISSING' && prototypeValue === liveValue
      ? pass(label, `${property} = ${prototypeValue}`, `${property} = ${liveValue}`)
      : fail(label, `${property} = ${prototypeValue}`, `${property} = ${liveValue}`);
  }, 'style', label);
}

function compareTextList(label, prototypeSelector, liveSelector) {
  return tag(async ({ prototypePage, livePage }) => {
    const prototypeValues = await readTextList(prototypePage, prototypeSelector);
    const liveValues = await readTextList(livePage, liveSelector);
    const prototypeActual = prototypeValues.join(' | ') || 'ELEMENT_MISSING';
    const liveActual = liveValues.join(' | ') || 'ELEMENT_MISSING';
    const passed = prototypeValues.length > 0
      && prototypeValues.length === liveValues.length
      && prototypeValues.every((value, index) => value === liveValues[index]);
    return passed
      ? pass(label, prototypeActual, liveActual)
      : fail(label, prototypeActual, liveActual);
  }, 'textList', label);
}

function compareMetric(label, prototypeSelector, liveSelector, metric, tolerancePx = DEFAULT_LAYOUT_TOLERANCE_PX) {
  return tag(async ({ prototypePage, livePage }) => {
    const prototypeValue = await readMetricValue(prototypePage, prototypeSelector, metric);
    const liveValue = await readMetricValue(livePage, liveSelector, metric);
    const numericPrototype = Number(prototypeValue);
    const numericLive = Number(liveValue);
    const passed = Number.isFinite(numericPrototype)
      && Number.isFinite(numericLive)
      && Math.abs(numericPrototype - numericLive) <= tolerancePx;
    return passed
      ? pass(label, `${metric} = ${numericPrototype}px`, `${metric} = ${numericLive}px`)
      : fail(label, `${metric} = ${prototypeValue}`, `${metric} = ${liveValue}`);
  }, 'metric', label);
}

async function readStyleValue(page, selector, property) {
  const count = await page.locator(selector).count();
  if (count === 0) {
    return 'ELEMENT_MISSING';
  }

  return page.locator(selector).first().evaluate(
    (node, styleProperty) => window.getComputedStyle(node)[styleProperty],
    property,
  );
}

async function readMetricValue(page, selector, metric) {
  const count = await page.locator(selector).count();
  if (count === 0) {
    return 'ELEMENT_MISSING';
  }

  return page.locator(selector).first().evaluate(
    (node, targetMetric) => {
      const rect = node.getBoundingClientRect();
      const rectValue = rect[targetMetric];
      if (typeof rectValue === 'number' && Number.isFinite(rectValue)) {
        return rectValue;
      }
      // Fall back to computed style for layout metrics not exposed on
      // DOMRect (e.g. borderTopLeftRadius, paddingTop, marginLeft).  We
      // strip the trailing "px" so the caller's Number(value) coercion
      // produces a finite pixel measurement comparable to DOMRect props.
      const computed = window.getComputedStyle(node)[targetMetric];
      if (typeof computed === 'string' && computed.endsWith('px')) {
        const px = Number.parseFloat(computed);
        return Number.isFinite(px) ? px : computed;
      }
      return computed;
    },
    metric,
  );
}

async function readTextList(page, selector) {
  const count = await page.locator(selector).count();
  if (count === 0) {
    return [];
  }

  const values = await page.locator(selector).evaluateAll(
    (nodes) => nodes.map((node) => node.textContent ?? ''),
  );
  return values.map((value) => normalizeText(value)).filter(Boolean);
}

async function login() {
  const configRes = await safeFetch(`${apiBase}/api/auth/config`);
  if (!configRes.ok) {
    throw new Error(`无法读取 /api/auth/config: ${configRes.status}`);
  }
  const configBody = await configRes.json();
  const passwordEnabled = configBody?.data?.password?.enabled === true;
  const oauthEnabled = configBody?.data?.oauth?.enabled === true;
  const username = process.env.PASSWORD_LOGIN_USERNAME?.trim()
    || process.env.TEST_PASSWORD_LOGIN_USERNAME?.trim();
  const password = process.env.PASSWORD_LOGIN_PASSWORD?.trim()
    || process.env.TEST_PASSWORD_LOGIN_PASSWORD?.trim();

  if (passwordEnabled && username && password) {
    const passwordRes = await safeFetch(`${apiBase}/api/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!passwordRes.ok) {
      throw new Error(`密码登录失败: ${passwordRes.status}`);
    }
    const passwordBody = await passwordRes.json();
    return passwordBody.data;
  }

  if (!oauthEnabled) {
    if (passwordEnabled) {
      throw new Error('password-login 已启用，但缺少 PASSWORD_LOGIN_USERNAME/PASSWORD');
    }
    throw new Error('/api/auth/config 未启用可用登录方式');
  }

  const loginRes = await safeFetch(`${apiBase}/api/auth/login`, { redirect: 'manual' });
  const location = loginRes.headers.get('location');
  if (!location) {
    throw new Error('无法从 /api/auth/login 获取回调地址');
  }

  const callbackUrl = new URL(location);
  const code = callbackUrl.searchParams.get('code');
  const state = callbackUrl.searchParams.get('state');
  if (!code || !state) {
    throw new Error('回调地址缺少 code/state');
  }

  const callbackRes = await safeFetch(`${apiBase}/api/auth/callback?code=${code}&state=${state}`);
  if (!callbackRes.ok) {
    throw new Error(`登录失败: ${callbackRes.status}`);
  }

  const body = await callbackRes.json();
  return body.data;
}

async function safeFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    throw new Error(`无法连接到服务 ${url}: ${toErrorMessage(error)}。请确认前后端服务已启动。`);
  }
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, '');
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function pass(label, prototypeActual, liveActual) {
  return { label, prototypeActual, liveActual, passed: true };
}

function fail(label, prototypeActual, liveActual) {
  return { label, prototypeActual, liveActual, passed: false };
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
