#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Hotfix Orchestration (CICD.md)
//
// 由 harness-sprint 复用执行 hotfix；本脚本提供分支与计划骨架。
//
// 用法:
//   hotfix.mjs init <issue-id> --severity p0|p1 [--from-tag vX.Y.Z]
//      从最近 prod tag 拉 hotfix/<issue> 分支，注入 hotfix 计划模板
//   hotfix.mjs back-merge <issue-id>
//      合并完成后调用 back-merge.mjs：main → test → develop
// =============================================================================

import { info, ok, err, fatal, run, tryRun, runCapture, existsSync, mkdirSync, writeText, join } from './lib/utils.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith('--')) { out[k] = n; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function latestTag() {
  return runCapture('git describe --tags --abbrev=0 --match "v*"', { ignoreError: true });
}

function init(issueId, args) {
  if (!issueId) fatal('issue-id 必填，如 INC-1234 或 GH-456');
  const severity = args.severity || 'p1';
  if (!['p0', 'p1'].includes(severity)) fatal('--severity 必须是 p0 或 p1');
  const fromTag = args['from-tag'] || latestTag();
  if (!fromTag) fatal('未找到任何 v* tag，无法基于生产版本拉 hotfix 分支');

  const branch = `hotfix/${issueId}`;
  run(`git fetch origin --tags`, { silent: true });
  run(`git checkout -B ${branch} ${fromTag}`);

  const planDir = join('sprints', branch.replace('/', '-'));
  if (!existsSync(planDir)) mkdirSync(planDir, { recursive: true });
  const planFile = join(planDir, 'PLAN.md');
  if (!existsSync(planFile)) {
    writeText(planFile, hotfixPlanTemplate({ issueId, severity, fromTag }));
  }
  ok(`hotfix 分支已就绪：${branch}（基于 ${fromTag}）`);
  info(`计划模板：${planFile}`);
  info('下一步：harness-sprint 复用执行；完成后 hotfix.mjs back-merge ' + issueId);
}

function hotfixPlanTemplate({ issueId, severity, fromTag }) {
  return `# Hotfix 计划：${issueId}

> 严重度：${severity}
> 基线 tag：${fromTag}
> 分支：hotfix/${issueId}

## 1. 现象

<必填：用户可见症状、影响范围、首次发生时间>

## 2. 根因

<必填：在不依赖完整 sprint 流程的前提下定位根因>

## 3. 修复方案

<必填：最小化修复点；不引入新依赖、不重构相邻代码>

## 4. 验证

- [ ] 单元测试覆盖回归点
- [ ] regression-critical 用例通过
- [ ] 在 test 环境冒烟通过
- [ ] L3 release-approval（缩短：仅审 patch + release notes）

## 5. 部署与回滚

- 部署：deploy.mjs --env prod --branch hotfix/${issueId}
- 回滚：deploy.mjs rollback --env prod
- 健康窗口：30 min（同生产配置）

## 6. 回灌

发布稳定后立即执行：node scripts/hotfix.mjs back-merge ${issueId}
`;
}

function backMerge(issueId) {
  if (!issueId) fatal('issue-id 必填');
  run(`node scripts/back-merge.mjs --from main --to test,develop --reason hotfix-${issueId}`);
}

function showHelp() {
  console.log(`
Harness Hotfix

  hotfix.mjs init <issue-id> --severity p0|p1 [--from-tag vX.Y.Z]
  hotfix.mjs back-merge <issue-id>

详见 docs/harness/CICD.md。
`);
}

const [, , cmd, id, ...rest] = process.argv;
const args = parseArgs(rest);

switch (cmd) {
  case 'init': init(id, args); break;
  case 'back-merge': backMerge(id); break;
  case undefined:
  case '--help':
  case '-h': showHelp(); break;
  default: err(`未知子命令: ${cmd}`); showHelp(); process.exit(1);
}
