#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Branch ↔ Environment Mapping Check (CICD.md)
//
// 校验当前分支只能部署到匹配的环境，避免 develop 部署 prod 等错配。
//
// 映射：
//   develop / sprint/* / feature/*           → dev
//   test / release/* / hotfix/* / promote/*  → test（临时占用）
//   main                                     → prod（唯一）
//
// 用法:
//   branch-env-check.mjs --env <env> [--branch <branch>]
// =============================================================================

import { info, ok, err, fatal, runCapture } from './lib/utils.mjs';

const RULES = [
  { env: 'dev', allow: [/^develop$/, /^sprint\//, /^promote\//, /^feature\//] },
  { env: 'test', allow: [/^test$/, /^promote\//, /^release\//, /^hotfix\//] },
  { env: 'prod', allow: [/^main$/] },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith('--')) { out[k] = n; i++; } else out[k] = true;
    }
  }
  return out;
}

function currentBranch() {
  // CI 优先级：GitHub push → GITHUB_REF_NAME；GitHub PR → GITHUB_HEAD_REF；GitLab → CI_COMMIT_REF_NAME
  const ref =
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    process.env.CI_COMMIT_REF_NAME;
  if (ref) return ref;
  return runCapture('git rev-parse --abbrev-ref HEAD');
}

function check(env, branch) {
  const rule = RULES.find(r => r.env === env);
  if (!rule) fatal(`未知环境：${env}`);
  const allowed = rule.allow.some(re => re.test(branch));
  if (!allowed) {
    err(`分支 ${branch} 不允许部署到 ${env}（CICD.md）`);
    err(`允许模式：${rule.allow.map(r => r.toString()).join(', ')}`);
    process.exit(1);
  }
  ok(`branch=${branch} → env=${env}：映射通过`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h || !args.env) {
  console.log('用法：branch-env-check.mjs --env <dev|test|prod> [--branch <branch>]');
  process.exit(args.env ? 1 : 0);
}
check(args.env, args.branch || currentBranch());
