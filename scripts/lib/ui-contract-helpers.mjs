// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改。
// =============================================================================
// UI Contract Helpers — 静态契约检查共享 helpers
//
// 用于 scripts/check-prototype-coverage.mjs 与 scripts/check-contract-strength.mjs
// 这些脚本只需要从 lint/ui-contracts.mjs::createAuditPlan() 取出契约结构，
// 不需要真正打开浏览器，因此提供"打 kind 标签的桩 helpers"即可。
// =============================================================================

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const MOBILE_VIEWPORT = { width: 375, height: 812 };

const stub = (kind) => (label, ...rest) => Object.assign(
  () => ({ passed: true, label, prototypeActual: 'static', liveActual: 'static' }),
  { kind, label, args: rest },
);

export const STATIC_HELPERS = {
  comparePresence: stub('presence'),
  compareCount: stub('count'),
  compareCountAtLeast: stub('countAtLeast'),
  compareLiveCount: stub('liveCount'),
  compareLiveAlignment: stub('liveAlignment'),
  compareStyle: stub('style'),
  compareTextList: stub('textList'),
  compareMetric: stub('metric'),
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
};

export async function loadContractsStatically({ sprintId, apiBase = 'http://localhost:3000', webBase = 'http://localhost:5173' } = {}) {
  const { resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const candidate = resolve(process.cwd(), 'lint/ui-contracts.mjs');
  const moduleUrl = pathToFileURL(candidate).href;
  const projectModule = await import(moduleUrl);
  if (typeof projectModule.createAuditPlan !== 'function') {
    throw new Error('lint/ui-contracts.mjs 未导出 createAuditPlan(...)');
  }
  const auditPlan = await projectModule.createAuditPlan({
    sprintId,
    runtime: { userId: 'static-audit' },
    helpers: STATIC_HELPERS,
    apiBase,
    webBase,
  });
  return {
    required: projectModule.required !== false && auditPlan.required !== false,
    reason: auditPlan.reason,
    contracts: Array.isArray(auditPlan.contracts) ? auditPlan.contracts : [],
  };
}
