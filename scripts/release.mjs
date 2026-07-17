#!/usr/bin/env node
/* eslint-disable harness/no-sql-concatenation */
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Release Orchestration (CICD.md)
// =============================================================================

import { info, ok, err, fatal, warn, run, tryRun, runCapture, existsSync, mkdirSync, readText, writeText, join } from './lib/utils.mjs';
import { readFileSync } from 'node:fs';

const RELEASE_ASSET_ROOT = 'deploy/release';

function releaseAssetDir(version) {
  return join(RELEASE_ASSET_ROOT, version);
}

const DEFAULT_RELEASE_NOTES_TEMPLATE = `# Release vX.Y.Z

> 由 scripts/release.mjs 自动生成；release-prep 任务在此基础上补全章节。

- **发布时间**：<YYYY-MM-DD>
- **发布范围**：<纳入本次发布的 sprint id 列表>
- **责任人**：<release manager>
- **变更类型**：feat | fix | refactor | chore（多选）
`;

const DEFAULT_MIGRATION_MANIFEST_TEMPLATE = `version: 1
release: vX.Y.Z
created_at: ""
created_by: ""
items: []
signature: ""
`;

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

function ensureVersion(version) {
  if (!/^v\d+\.\d+\.\d+(-[a-z0-9.]+)?$/.test(version || '')) fatal(`版本号格式错误：${version}（期望 vX.Y.Z）`);
}

function isDryRun(args) {
  return !!args['dry-run'];
}

function loadTemplateOrDefault(path, fallback) {
  if (existsSync(path)) return readFileSync(path, 'utf-8');
  return fallback;
}

function resolveTestRef(dryRun) {
  const candidates = ['origin/test', 'test'];
  for (const ref of candidates) {
    if (tryRun(`git rev-parse --verify --quiet ${ref}`).ok) return ref;
  }
  if (dryRun) return 'origin/main';
  return null;
}

function validateReleaseInputs(version, args) {
  ensureVersion(version);
  const dryRun = isDryRun(args);
  tryRun('git fetch origin --no-tags', { silent: true });
  const branch = `release/${version}`;
  const sprints = (args.sprints || '').split(',').map((item) => item.trim()).filter(Boolean);
  const problems = [];
  const testRef = resolveTestRef(dryRun);

  if (tryRun(`git rev-parse --verify --quiet origin/${branch}`).ok) {
    problems.push(`origin/${branch} 已存在；请先 archive 或人工删除后再 init`);
  }
  if (!testRef) problems.push('未找到 test 分支引用（origin/test 或 test）');

  for (const sid of sprints) {
    const series = sid.match(/^sprint-\d+/)?.[0] ?? sid;
    const candidates = [
      `docs/acceptance-reports/${sid}-boss-signoff.yml`,
      `docs/acceptance-reports/${series}-boss-signoff.yml`,
    ];
    const found = candidates.find((path) => existsSync(path));
    if (!found) {
      problems.push(`缺少 product-acceptance：${candidates.join(' / ')}`);
      continue;
    }
    const text = readText(found);
    if (!/^decision:\s*approved/m.test(text)) {
      problems.push(`sprint ${sid} 未 approved（${found}）`);
      continue;
    }
    const shaMatch = text.match(/^commit_sha:\s*([a-f0-9]{7,40})/m);
    if (!shaMatch) {
      problems.push(`sprint ${sid} signoff 缺少 commit_sha`);
      continue;
    }
    const ancestor = testRef ? tryRun(`git merge-base --is-ancestor ${shaMatch[1]} ${testRef}`) : { ok: false };
    if (!ancestor.ok) problems.push(`sprint ${sid} 的 commit ${shaMatch[1]} 未抵达 ${testRef || 'test'}`);
  }

  return { branch, sprints, problems, testRef };
}

function init(version, args) {
  const { branch, sprints, problems, testRef } = validateReleaseInputs(version, args);
  const sprintNote = sprints.length ? `; sprints=${sprints.join(',')}` : '';
  if (isDryRun(args)) {
    info(`release init dry-run: branch=${branch}`);
    info(`release init dry-run: merge ${testRef || 'test'} into ${branch}${sprintNote}`);
    if (problems.length > 0) warn(`release init dry-run 发现问题：${problems.join('；')}`);
    ok(`release/${version} init(dry-run) 完成`);
    return;
  }
  if (problems.length > 0) fatal(problems.join('；'));
  run(`git switch -c ${branch} origin/main`);
  run(`git merge --no-ff ${testRef} -m "release(${version}): include test HEAD${sprintNote}"`);
  scaffold(version, args);
  ok(`release/${version} 已初始化（合并 test HEAD${sprintNote}）`);
}

function scaffold(version, args = {}) {
  ensureVersion(version);
  const root = releaseAssetDir(version);
  const notes = join(root, 'release-notes.md');
  const manifest = join(root, 'migrations', 'manifest.yml');
  if (isDryRun(args)) {
    info(`scaffold dry-run: will create ${notes}`);
    info(`scaffold dry-run: will create ${manifest}`);
    ok(`${root} scaffold(dry-run) 完成`);
    return;
  }

  for (const sub of ['', 'migrations', 'deploy', 'observability']) {
    const path = sub ? join(root, sub) : root;
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }

  if (!existsSync(notes)) {
    const tpl = loadTemplateOrDefault('templates/release-notes.md', DEFAULT_RELEASE_NOTES_TEMPLATE).replace(/vX\.Y\.Z/g, version);
    writeText(notes, tpl);
  }
  if (!existsSync(manifest)) {
    const tpl = loadTemplateOrDefault('templates/migration/manifest.yml.tpl', DEFAULT_MIGRATION_MANIFEST_TEMPLATE).replace(/vX\.Y\.Z/g, version);
    writeText(manifest, tpl);
  }
  ok(`${root} 骨架就绪`);
}

function aggregateQuality(version, args = {}) {
  ensureVersion(version);
  const root = releaseAssetDir(version);
  const out = { release: version, generated_at: new Date().toISOString(), sprints: [] };
  const candidates = [
    { dir: 'docs/test-reports', filter: (name) => /-quality\.json$/.test(name), id: (name) => name.replace(/-quality\.json$/, '') },
    { dir: 'sprints', filter: () => true, id: (name) => name, file: 'quality-summary.json' },
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate.dir)) continue;
    const entries = tryRun(`ls -1 ${candidate.dir}`).stdout.trim().split('\n').filter(Boolean);
    for (const name of entries) {
      const file = candidate.file ? join(candidate.dir, name, candidate.file) : join(candidate.dir, name);
      if (!candidate.file && !candidate.filter(name)) continue;
      if (!existsSync(file)) continue;
      try {
        out.sprints.push({ id: candidate.id(name), summary: JSON.parse(readText(file)) });
      } catch {
        // ignore non-json
      }
    }
  }

  if (isDryRun(args)) {
    if (out.sprints.length === 0) warn('aggregate-quality dry-run：未找到任何可聚合的质量摘要');
    else info(`aggregate-quality dry-run：将聚合 ${out.sprints.length} 个摘要`);
    ok(`${root} aggregate-quality(dry-run) 完成`);
    return;
  }

  if (out.sprints.length === 0) {
    err('未找到任何 sprint 质量摘要（docs/test-reports/*-quality.json 或 sprints/*/quality-summary.json）');
    err('提示：scripts/quality-score.mjs 需在 sprint 完成时输出 sidecar JSON 摘要');
    process.exit(1);
  }

  const target = join(root, 'quality-summary.json');
  writeText(target, JSON.stringify(out, null, 2));
  ok(`质量聚合 → ${target}（${out.sprints.length} 个 sprint）`);
}

function regression(version, args = {}) {
  ensureVersion(version);
  if (isDryRun(args)) {
    info(`regression dry-run: owner=release-${version}`);
    info(`regression dry-run: deploy.mjs preflight --env test --tag release-${version} --dry-run`);
    info(`regression dry-run: deploy.mjs --env test --tag release-${version} --driver compose --dry-run`);
    info(`regression dry-run: quality-score.mjs --level L3 --release ${version}`);
    ok(`release/${version} regression(dry-run) 完成`);
    return;
  }

  info(`release/${version}：占用 test 环境锁`);
  const lockOwner = `release-${version}`;
  run(`node scripts/lock.mjs acquire test --owner ${lockOwner} --ttl 14400`);
  let passed = false;
  try {
    run(`node scripts/deploy.mjs --env test --tag release-${version} --driver compose`);
    run(`node scripts/quality-score.mjs --level L3 --release ${version}`);
    passed = true;
    ok(`release/${version} 回归通过（test 锁保留至 archive 或 production 部署）`);
  } finally {
    if (!passed) {
      tryRun(`node scripts/lock.mjs release test --owner ${lockOwner}`);
      err('regression 失败：已释放 test 锁，复查 quality 报告后重跑');
    }
  }
}

function createPR(version, args = {}) {
  ensureVersion(version);
  const branch = `release/${version}`;
  const notesFile = join(releaseAssetDir(version), 'release-notes.md');
  if (isDryRun(args)) {
    info(`release pr dry-run: branch=${branch} base=main body=${notesFile}`);
    ok(`release/${version} pr(dry-run) 完成`);
    return;
  }
  run(`git push -u origin ${branch}`, { silent: false });
  const url = runCapture(`node scripts/pr-adapter.mjs create --base main --head ${branch} --title "release: ${version}" --body-file ${notesFile} --labels release`);
  ok(`Release PR: ${url}`);
}

function approve(version, args) {
  ensureVersion(version);
  const decision = args.reject ? 'rejected' : 'approved';
  const by = args.by || process.env.GITHUB_ACTOR || 'Boss';
  const summary = args.summary || '';
  const target = join(releaseAssetDir(version), 'approval.yml');
  if (isDryRun(args)) {
    info(`approve dry-run: target=${target} decision=${decision} by=${by}`);
    ok(`release/${version} approve(dry-run) 完成`);
    return;
  }
  const lines = [
    `release: ${version}`,
    `decision: ${decision}`,
    `confirmed_by: ${by}`,
    `confirmed_at: ${new Date().toISOString()}`,
    'source: manual',
    'summary: |',
    ...summary.split('\n').map((line) => `  ${line}`),
    '',
  ];
  writeText(target, lines.join('\n'));
  ok(`${target} 已写入：decision=${decision}`);
}

function archive(version, args = {}) {
  ensureVersion(version);
  const tag = version;
  if (isDryRun(args)) {
    info(`archive dry-run: tag=${tag} delete=origin/release/${version}`);
    ok(`release/${version} archive(dry-run) 完成`);
    return;
  }

  run('git fetch origin main --tags', { silent: true });
  const tagExists = tryRun(`git rev-parse --verify --quiet refs/tags/${tag}`).ok;
  if (!tagExists) {
    run(`git tag -a ${tag} -m "release ${version}" origin/main`, { silent: true });
    run(`git push origin ${tag}`, { silent: true });
  } else {
    info(`tag ${tag} 已存在，跳过创建`);
  }
  const branchExists = tryRun(`git rev-parse --verify --quiet origin/release/${version}`).ok;
  if (branchExists) {
    run(`git push origin --delete release/${version}`, { silent: true });
  } else {
    info(`release/${version} 远端分支已不存在，跳过删除`);
  }
  tryRun(`node scripts/lock.mjs release test --owner release-${version}`);
  ok(`release/${version} 已归档（tag=${tag}）`);
}

function showHelp() {
  console.log(`
Harness Release — Release 编排

  release.mjs init <vX.Y.Z> --sprints s1,s2,s3 [--dry-run]
  release.mjs scaffold <vX.Y.Z> [--dry-run]
  release.mjs aggregate-quality <vX.Y.Z> [--dry-run]
  release.mjs regression <vX.Y.Z> [--dry-run]
  release.mjs pr <vX.Y.Z> [--dry-run]
  release.mjs approve <vX.Y.Z> [--by Boss] [--summary "..."] [--reject] [--dry-run]
  release.mjs archive <vX.Y.Z> [--dry-run]

  详见 docs/SPRINT.md 与 lint/task-rules.yml。
`);
}

const [, , cmd, version, ...rest] = process.argv;
const args = parseArgs(rest);

switch (cmd) {
  case 'init':
    init(version, args);
    break;
  case 'scaffold':
    scaffold(version, args);
    break;
  case 'aggregate-quality':
    aggregateQuality(version, args);
    break;
  case 'regression':
    regression(version, args);
    break;
  case 'pr':
    createPR(version, args);
    break;
  case 'approve':
    approve(version, args);
    break;
  case 'archive':
    archive(version, args);
    break;
  case undefined:
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    err(`未知子命令: ${cmd}`);
    showHelp();
    process.exit(1);
}
