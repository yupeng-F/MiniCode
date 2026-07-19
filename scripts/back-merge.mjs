#!/usr/bin/env node
/* eslint-disable harness/no-sql-concatenation */
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Back-Merge (CICD.md)
//
// 在 main 合并后，将 main 同步回 test 与 develop，避免分支漂移。
// 触发点：
//   - production/release deploy-sprint 完成后
//   - hotfix.mjs back-merge（hotfix 完成后）
//
// 用法:
//   back-merge.mjs --from main --to test,develop [--reason <text>] [--dry-run]
// =============================================================================

import { info, ok, err, fatal, run, tryRun, runCapture } from './lib/utils.mjs';

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

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

function backMerge({ from, toList, reason, dryRun }) {
  run('git fetch origin --no-tags', { silent: true });
  const sha = runCapture(`git rev-parse --short=7 origin/${from}`).trim();
  const slug = (reason || 'auto').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 24);
  for (const to of toList) {
    info(`back-merge: ${from} → ${to}`);
    if (dryRun) continue;
    // 分支名稳定：基于 from 的 sha + reason，可重复执行（同 sha 不会重复创建）
    const branch = `back-merge/${to}-${sha}-${slug}`;
    const exists = tryRun(`git rev-parse --verify --quiet origin/${branch}`).ok;
    if (exists) {
      info(`分支已存在 origin/${branch}，跳过创建（同 sha 已开过 PR）`);
      continue;
    }
    run(`git switch -c ${branch} origin/${to}`);
    const result = tryRun(`git merge --no-ff origin/${from} -m "back-merge(${reason || 'auto'}): ${from} → ${to}"`);
    if (!result.ok) {
      err(`合并冲突：${from} → ${to}。已停在分支 ${branch}，请人工解决后推送 PR`);
      process.exit(2);
    }
    run(`git push -u origin ${branch}`);
    runCapture(
      `node scripts/pr-adapter.mjs create --base ${shellEscape(to)} --head ${shellEscape(branch)} --title ${shellEscape(`back-merge: ${from} → ${to}`)} --labels back-merge`,
    );
    ok(`back-merge PR 已创建：${from} → ${to}`);
  }
}

function showHelp() {
  console.log(`
Harness Back-Merge

  back-merge.mjs --from <branch> --to <a,b,...> [--reason <text>] [--dry-run]

详见 docs/harness/CICD.md。
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) { showHelp(); process.exit(0); }
if (!args.from || !args.to) { showHelp(); fatal('--from 与 --to 必填'); }

backMerge({
  from: args.from,
  toList: args.to.split(','),
  reason: args.reason,
  dryRun: !!args['dry-run'],
});
