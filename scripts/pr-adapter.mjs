#!/usr/bin/env node
/* eslint-disable harness/no-sql-concatenation */
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — VCS Platform Adapter (CICD.md)
//
// 统一 PR / MR 创建与查询接口，屏蔽 GitHub / GitLab 差异。
// 所有 Agent 与脚本必须通过本适配器与 VCS 交互；ESLint 规则 harness/no-direct-vcs-cli
// 禁止直接调用 `gh pr` / `glab mr`。
//
// 用法:
//   pr-adapter.mjs platform                       # 输出 github | gitlab | local
//   pr-adapter.mjs create --base <branch> --head <branch> --title <t> [--body-file <f>] [--labels a,b]
//   pr-adapter.mjs status --number <n>             # 输出 open | merged | closed | conflicts
//   pr-adapter.mjs merge --number <n> [--method squash|merge|rebase]
//   pr-adapter.mjs comment --number <n> --body-file <f>
// =============================================================================

import { info, ok, err, fatal, runCapture, tryRun, hasCmd, existsSync, readText } from './lib/utils.mjs';

// ─── Platform Detection ───────────────────────────────────────────────────────

export function detectPlatform() {
  if (process.env.HARNESS_PLATFORM) return process.env.HARNESS_PLATFORM;
  const url = tryRun('git config --get remote.origin.url').stdout.trim();
  if (/github\.com[:/]/.test(url)) return 'github';
  if (/gitlab\./.test(url)) return 'gitlab';
  return 'local';
}

// ─── Argument Parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else { out[key] = true; }
    } else { out._.push(a); }
  }
  return out;
}

function shellEscape(s) {
  // POSIX 单引号转义：所有内容包在单引号里，对单引号本身做 '\'' 替换
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ─── GitHub Adapter ───────────────────────────────────────────────────────────

const gh = {
  ensure() { if (!hasCmd('gh')) fatal('gh CLI 未安装。运行 brew install gh 或访问 https://cli.github.com'); },

  create({ base, head, title, bodyFile, labels }) {
    this.ensure();
    const parts = ['gh', 'pr', 'create', '--base', base, '--head', head, '--title', shellEscape(title)];
    if (bodyFile) parts.push('--body-file', shellEscape(bodyFile)); else parts.push('--body', `''`);
    if (labels) parts.push('--label', shellEscape(labels));
    return runCapture(parts.join(' '));
  },

  status(n) {
    this.ensure();
    const out = runCapture(`gh pr view ${n} --json state,mergeable,mergeStateStatus`);
    const j = JSON.parse(out);
    if (j.state === 'MERGED') return 'merged';
    if (j.state === 'CLOSED') return 'closed';
    if (j.mergeable === 'CONFLICTING') return 'conflicts';
    return 'open';
  },

  merge(n, method = 'squash') {
    this.ensure();
    runCapture(`gh pr merge ${n} --${method} --delete-branch`);
  },

  comment(n, bodyFile) {
    this.ensure();
    runCapture(`gh pr comment ${n} --body-file ${bodyFile}`);
  },
};

// ─── GitLab Adapter ───────────────────────────────────────────────────────────

const gl = {
  ensure() { if (!hasCmd('glab')) fatal('glab CLI 未安装。访问 https://gitlab.com/gitlab-org/cli'); },

  pushOptionCreate({ base, head, title, bodyFile, labels }) {
    const pushOptions = [
      '-o', 'merge_request.create',
      '-o', `merge_request.target=${base}`,
      '-o', `merge_request.title=${title}`,
      '-o', 'merge_request.remove_source_branch',
    ];
    if (labels) pushOptions.push('-o', `merge_request.label=${labels}`);
    if (bodyFile) {
      if (!existsSync(bodyFile)) fatal(`body-file 不存在: ${bodyFile}`);
      const description = readText(bodyFile).trim();
      if (description) pushOptions.push('-o', `merge_request.description=${description}`);
    }

    const escapedOptions = pushOptions.map(shellEscape).join(' ');
    const output = runCapture(`git push -u ${escapedOptions} origin HEAD:${shellEscape(head)} 2>&1`);
    const urls = output.match(/https?:\/\/\S+\/-\/merge_requests\/\d+/g) || [];
    return urls[urls.length - 1] || output.trim() || `GitLab MR requested: ${head} → ${base}`;
  },

  create({ base, head, title, bodyFile, labels }) {
    if (!hasCmd('glab')) {
      info('glab CLI 未安装，使用 GitLab push-options fallback 创建 MR（仍由 pr-adapter 统一封装）');
      return this.pushOptionCreate({ base, head, title, bodyFile, labels });
    }
    // GitLab 是手动 MR：本命令仅生成 MR，但合并需手动操作（CICD.md）
    const parts = ['glab', 'mr', 'create', '--target-branch', base, '--source-branch', head,
      '--title', shellEscape(title)];
    if (bodyFile) parts.push('--description', `"$(cat ${shellEscape(bodyFile).slice(1, -1)})"`);
    else parts.push('--description', `''`);
    if (labels) parts.push('--label', shellEscape(labels));
    return runCapture(parts.join(' '));
  },

  status(n) {
    this.ensure();
    const out = runCapture(`glab mr view ${n} --output json`);
    const j = JSON.parse(out);
    if (j.state === 'merged') return 'merged';
    if (j.state === 'closed') return 'closed';
    if (j.merge_status === 'cannot_be_merged') return 'conflicts';
    return 'open';
  },

  merge(n) {
    this.ensure();
    // GitLab 协议：不自动合并，提示人工。退出 0 让上游脚本继续处理（不再 exit 2 中断流水线）。
    info(`GitLab 模式为手动合并：请到 MR !${n} 页面点击 Merge`);
    const out = runCapture(`glab mr view ${n} --output json`);
    try { console.log(JSON.parse(out).web_url || ''); } catch { /* */ }
  },

  comment(n, bodyFile) {
    this.ensure();
    runCapture(`glab mr note ${n} --message "$(cat ${bodyFile})"`);
  },
};

// ─── Local Adapter (offline / test) ───────────────────────────────────────────

const local = {
  create({ base, head, title }) {
    info(`[local] 模拟 PR：${head} → ${base}：${title}`);
    return 'PR-LOCAL-0';
  },
  status() { return 'open'; },
  merge() { info('[local] 模拟合并'); },
  comment() { info('[local] 模拟评论'); },
};

const adapters = { github: gh, gitlab: gl, local };

// ─── Main ─────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
Harness PR Adapter — 统一 PR / MR 接口

  pr-adapter.mjs platform
  pr-adapter.mjs create --base <branch> --head <branch> --title <t> [--body-file <f>] [--labels a,b]
  pr-adapter.mjs status --number <n>
  pr-adapter.mjs merge --number <n> [--method squash|merge|rebase]
  pr-adapter.mjs comment --number <n> --body-file <f>
`);
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  const platform = detectPlatform();
  const a = adapters[platform];

  switch (cmd) {
    case 'platform':
      console.log(platform);
      break;
    case 'create': {
      if (!args.base || !args.head || !args.title) fatal('create 需要 --base / --head / --title');
      const url = a.create({ base: args.base, head: args.head, title: args.title,
        bodyFile: args['body-file'], labels: args.labels });
      ok(url);
      break;
    }
    case 'status':
      if (!args.number) fatal('status 需要 --number');
      console.log(a.status(args.number));
      break;
    case 'merge':
      if (!args.number) fatal('merge 需要 --number');
      a.merge(args.number, args.method || 'squash');
      ok(`PR/MR #${args.number} 已合并`);
      break;
    case 'comment':
      if (!args.number || !args['body-file']) fatal('comment 需要 --number 与 --body-file');
      a.comment(args.number, args['body-file']);
      ok(`已评论 PR/MR #${args.number}`);
      break;
    case '--help':
    case '-h':
    case undefined:
      showHelp();
      break;
    default:
      err(`未知子命令: ${cmd}`);
      showHelp();
      process.exit(1);
  }
}

main();
