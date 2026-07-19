#!/usr/bin/env node
/* eslint-disable harness/no-sql-concatenation */
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Test Promotion (CICD.md)
// =============================================================================

import { info, ok, err, fatal, warn, run, tryRun, runCapture, existsSync, readText, writeText, loadYaml } from './lib/utils.mjs';
import { loadEnvironmentsCompat } from './lib/deploy-config.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function ensureTestEnabled() {
  const cfg = loadEnvironmentsCompat();
  if (!cfg?.environments?.test?.enabled) {
    info('deploy.yml: environments.test.enabled=false → 跳过 promote');
    process.exit(0);
  }
}

function resolveSourceSha(sourceRef) {
  const probe = tryRun(`git rev-parse --short ${sourceRef}`);
  if (!probe.ok) fatal(`无法解析 source ref：${sourceRef}`);
  return probe.stdout.trim();
}

function resolveSourceRef(inputRef, dryRun) {
  const candidates = [
    inputRef,
    'origin/develop',
    'develop',
    'origin/main',
    'main',
    'HEAD',
  ].filter(Boolean);
  for (const ref of candidates) {
    if (tryRun(`git rev-parse --verify --quiet ${ref}`).ok) {
      if (ref !== inputRef) warn(`source ref ${inputRef} 不存在，dry-run 回退到 ${ref}`);
      return ref;
    }
  }
  if (dryRun) fatal(`dry-run 无法解析任何可用 source ref：${candidates.join(', ')}`);
  fatal(`无法解析 source ref：${inputRef}`);
}

function printPromotePlan({ id, branch, sourceRef, sha, dryRun }) {
  info(`promote: id=${id} branch=${branch} source=${sourceRef} sha=${sha} dry-run=${dryRun}`);
  info(`image promote: dev-${sha} -> test-${sha}`);
  info(`PR handoff: base=test head=${branch} title="promote(${id}): ${sha}"`);
}

function appendLog(entry) {
  const path = '.harness/state/promotion-log.yml';
  const head = 'log:\n';
  const prev = existsSync(path) ? readText(path) : '';
  const body = prev.startsWith(head) ? prev.slice(head.length) : prev;
  const line = `- kind: ${entry.kind}\n  id: ${entry.id || ''}\n  sha: ${entry.sha || ''}\n  branch: ${entry.branch || ''}\n  ts: ${entry.ts}\n`;
  writeText(path, head + body + line);
}

function status() {
  const path = '.harness/state/promotion-log.yml';
  if (!existsSync(path)) {
    info('无 promote 历史');
    return;
  }
  process.stdout.write(readText(path));
}

function promoteTest(args) {
  ensureTestEnabled();
  const dryRun = !!args['dry-run'];
  const trainMode = !!args.train;
  const requestedSourceRef = args['source-ref'] || 'origin/develop';
  const id = trainMode
    ? `train-${new Date().toISOString().slice(0, 10)}`
    : (args.sprints || 'manual').replace(/,/g, '-');

  tryRun('git fetch origin --no-tags', { silent: true });
  const sourceRef = resolveSourceRef(requestedSourceRef, dryRun);
  const sha = resolveSourceSha(sourceRef);
  const branch = `promote/${id}`;

  printPromotePlan({ id, branch, sourceRef, sha, dryRun });
  if (dryRun) {
    ok('promote dry-run 完成（未获取锁、未创建分支、未写日志、未创建 PR）');
    return;
  }

  run(`node scripts/lock.mjs acquire test --owner promote-${id} --ttl 7200`, { silent: false });
  try {
    run(`git switch -c ${branch} ${sourceRef}`, { silent: true });
    run(`node scripts/image-promote.mjs --from dev-${sha} --to test-${sha}`);
    run(`git push -u origin ${branch}`, { silent: true });
    const url = runCapture(`node scripts/pr-adapter.mjs create --base test --head ${branch} --title "promote(${id}): ${sha}" --labels promote`);
    info(`PR/MR: ${url}`);
    info('PR 已创建：等待 quality(L2) + integration 通过后人工或脚本合并');
    ok('promote 流水线已启动');
    appendLog({ kind: 'promote', id, sha, branch, ts: new Date().toISOString() });
  } catch (error) {
    const release = tryRun(`node scripts/lock.mjs release test --owner promote-${id}`);
    if (!release.ok) err('promote 失败，且未能自动释放 test 锁，请人工确认');
    throw error;
  }
}

function showHelp() {
  console.log(`
Harness Promote — Test 提升

  promote.mjs test [--sprints a,b] [--train] [--source-ref origin/develop] [--dry-run]
  promote.mjs status

详见 docs/harness/CICD.md。
`);
}

const [, , target, ...rest] = process.argv;
const args = parseArgs(rest);

switch (target) {
  case 'test':
    promoteTest(args);
    break;
  case 'status':
    status();
    break;
  case undefined:
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    err(`未知目标: ${target}`);
    showHelp();
    process.exit(1);
}
