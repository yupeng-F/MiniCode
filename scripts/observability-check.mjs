#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Observability Validator (CICD.md)
//
// 校验项目 observability/ 目录最低产出物存在；通过 release-prep 与 quality(L3) 触发。
//
// 用法:
//   observability-check.mjs validate                  # 校验目录结构
//   observability-check.mjs scaffold                  # 项目首次接入：从 templates 复制
// =============================================================================

import { info, ok, err, fatal, existsSync, readText, writeText, join } from './lib/utils.mjs';
import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { HARNESS_PATHS } from '../config/harness-paths.mjs';

const REQUIRED = {
  'observability/dashboards': { minFiles: 1, hint: 'JSON dashboard 导出（Grafana/CloudWatch 等）' },
  'observability/alerts': { minFiles: 1, hint: 'PromQL 告警规则' },
  'observability/queries': { minFiles: 1, hint: 'PromQL / LogQL 查询模板' },
  'observability/runbooks': { minFiles: 1, hint: 'On-call runbook（每个 alert 一份）' },
};

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => !f.startsWith('.'));
}

function validate() {
  const errors = [];
  for (const [dir, req] of Object.entries(REQUIRED)) {
    const files = listFiles(dir);
    if (files.length < req.minFiles) {
      errors.push(`${dir}: 至少 ${req.minFiles} 个文件（${req.hint}）`);
    }
  }
  if (errors.length) {
    err('observability 校验失败：');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  ok('observability 校验通过');
}

function scaffold() {
  for (const dir of Object.keys(REQUIRED)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // 从 .harness/framework/templates/observability 复制示例
  const tplRoot = join(HARNESS_PATHS.templates, 'observability');
  if (existsSync(join(tplRoot, 'promql'))) {
    for (const f of readdirSync(join(tplRoot, 'promql'))) {
      const src = join(tplRoot, 'promql', f);
      const dst = join('observability/queries', f);
      if (!existsSync(dst)) copyFileSync(src, dst);
    }
  }
  if (existsSync(join(tplRoot, 'logql'))) {
    for (const f of readdirSync(join(tplRoot, 'logql'))) {
      const src = join(tplRoot, 'logql', f);
      const dst = join('observability/queries', f);
      if (!existsSync(dst)) copyFileSync(src, dst);
    }
  }
  // 写一个最小 alert + runbook 占位
  const alert = 'observability/alerts/error-rate.yml';
  if (!existsSync(alert)) writeText(alert, `# Alert: 5xx error rate exceeds 1%\nexpr: error_rate_5xx > 0.01\nfor: 5m\nseverity: warning\nrunbook: observability/runbooks/error-rate.md\n`);
  const rb = 'observability/runbooks/error-rate.md';
  if (!existsSync(rb)) writeText(rb, `# Runbook: 5xx error rate\n\n## 步骤\n1. 查看 dashboards/error-rate\n2. 拉 trace_id：observability/queries/trace.logql\n3. 决策：rollback (deploy.mjs rollback) 或 hotfix\n`);
  const dash = 'observability/dashboards/.gitkeep';
  if (!existsSync(dash)) writeText(dash, '# 项目导出 Grafana / CloudWatch dashboard JSON 至此\n');
  ok('observability 骨架已生成');
}

function showHelp() {
  console.log(`
Harness Observability Check

  observability-check.mjs validate
  observability-check.mjs scaffold

详见 docs/harness/CICD.md 与 docs/harness/OBSERVABILITY.md。
`);
}

const [, , cmd] = process.argv;
switch (cmd) {
  case 'validate': validate(); break;
  case 'scaffold': scaffold(); break;
  case undefined:
  case '--help':
  case '-h': showHelp(); break;
  default: err(`未知子命令: ${cmd}`); showHelp(); process.exit(1);
}
