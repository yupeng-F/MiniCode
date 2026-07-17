#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Git Worktree 管理 (H-07)
//
// Agent 每次任务在独立 worktree 中工作，支持并行任务。
// 自动端口分配避免冲突，PID 追踪确保清理干净。
//
// 用法:
//   worktree.mjs create <task-id> [base-ref]
//   worktree.mjs destroy <task-id>
//   worktree.mjs list
//   worktree.mjs ports <task-id>
// =============================================================================

import {
  info, ok, err, fatal,
  run, tryRun,
  existsSync, readText, writeText,
  join, basename,
  readdirSync, mkdirSync, rmSync,
} from './lib/utils.mjs';

const WORKTREE_ROOT = '.worktrees';
const BASE_API_PORT = 3000;
const BASE_WEB_PORT = 5173;
const PORT_RANGE = 997;

// ─── POSIX cksum（与 macOS/Linux cksum 命令输出一致）────────────────────────

function posixCksum(str) {
  const buf = Buffer.from(str, 'utf-8');
  let crc = 0;

  for (const byte of buf) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80000000) {
        crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
  }

  // Fold in the byte count
  let n = buf.length;
  while (n > 0) {
    crc = (crc ^ ((n & 0xFF) << 24)) >>> 0;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80000000) {
        crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
    n = n >>> 8;
  }

  return (~crc) >>> 0;
}

// ─── 端口分配（基于 task-id 哈希，确定性映射）─────────────────────────────────

function portOffset(taskId) {
  const hash = posixCksum(taskId);
  return (hash % PORT_RANGE) + 1;
}

function apiPort(taskId) { return BASE_API_PORT + portOffset(taskId); }
function webPort(taskId) { return BASE_WEB_PORT + portOffset(taskId); }

// ─── 命令 ────────────────────────────────────────────────────────────────────

function cmdCreate(taskId, baseRef = 'HEAD') {
  if (!taskId) fatal('用法: worktree.mjs create <task-id> [base-ref]');

  const wtPath = join(WORKTREE_ROOT, taskId);
  const branch = `task/${taskId}`;

  if (existsSync(wtPath)) {
    err(`Worktree 已存在: ${wtPath}`);
    process.exit(1);
  }

  info(`创建 worktree: ${wtPath} (基于 ${baseRef})`);
  run(`git worktree add "${wtPath}" -b "${branch}" "${baseRef}"`);

  // 安装依赖
  if (existsSync(join(wtPath, 'pnpm-lock.yaml'))) {
    info('安装依赖 (pnpm)...');
    tryRun('pnpm install --frozen-lockfile --silent', { cwd: wtPath });
  } else if (existsSync(join(wtPath, 'package-lock.json'))) {
    info('安装依赖 (npm)...');
    tryRun('npm ci --silent', { cwd: wtPath });
  } else if (existsSync(join(wtPath, 'yarn.lock'))) {
    info('安装依赖 (yarn)...');
    tryRun('yarn install --frozen-lockfile --silent', { cwd: wtPath });
  }

  // 创建 .harness 状态目录 + 写入端口配置
  mkdirSync(join(wtPath, '.harness'), { recursive: true });
  const ap = apiPort(taskId);
  const wp = webPort(taskId);
  writeText(join(wtPath, '.harness', 'ports'), `API_PORT=${ap}\nWEB_PORT=${wp}\n`);

  ok(`Worktree 就绪: ${wtPath}`);
  ok(`端口分配: API=${ap}  WEB=${wp}`);
  console.log(wtPath);
}

function cmdDestroy(taskId) {
  if (!taskId) fatal('用法: worktree.mjs destroy <task-id>');

  const wtPath = join(WORKTREE_ROOT, taskId);

  // 终止该 worktree 中记录的所有进程
  const pidsFile = join(wtPath, '.harness', 'pids');
  if (existsSync(pidsFile)) {
    info('终止关联进程...');
    const pids = readText(pidsFile).split('\n').filter(Boolean);
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) continue;
      try {
        process.kill(pid, 0); // check if alive
        process.kill(pid);
        info(`  已终止 PID ${pid}`);
      } catch {
        // process already gone — ignore
      }
    }
  }

  // 移除 worktree
  if (existsSync(wtPath)) {
    info(`移除 worktree: ${wtPath}`);
    const result = tryRun(`git worktree remove "${wtPath}" --force`);
    if (!result.ok) {
      rmSync(wtPath, { recursive: true, force: true });
    }
  }

  // 删除任务分支
  tryRun(`git branch -D "task/${taskId}"`);

  ok(`Worktree 已清理: ${taskId}`);
}

function cmdList() {
  if (!existsSync(WORKTREE_ROOT)) {
    info('无活跃 worktree');
    return;
  }

  const entries = readdirSync(WORKTREE_ROOT, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory());

  if (dirs.length === 0) {
    info('无活跃 worktree');
    return;
  }

  console.log(
    'TASK'.padEnd(20) + ' ' +
    'API'.padEnd(8) + ' ' +
    'WEB'.padEnd(8) + ' ' +
    'PATH',
  );
  console.log(
    '----'.padEnd(20) + ' ' +
    '---'.padEnd(8) + ' ' +
    '---'.padEnd(8) + ' ' +
    '----',
  );

  for (const entry of dirs) {
    const taskId = entry.name;
    const ap = apiPort(taskId);
    const wp = webPort(taskId);
    const wtPath = join(WORKTREE_ROOT, taskId) + '/';
    console.log(
      taskId.padEnd(20) + ' ' +
      String(ap).padEnd(8) + ' ' +
      String(wp).padEnd(8) + ' ' +
      wtPath,
    );
  }
}

function cmdPorts(taskId) {
  if (!taskId) fatal('用法: worktree.mjs ports <task-id>');
  console.log(`API_PORT=${apiPort(taskId)}`);
  console.log(`WEB_PORT=${webPort(taskId)}`);
}

function showHelp() {
  console.log(`\
Harness Worktree — Agent 工作空间隔离 (H-07)

用法:
  worktree.mjs create  <task-id> [base-ref]  创建独立 worktree + 安装依赖
  worktree.mjs destroy <task-id>             终止进程 + 移除 worktree
  worktree.mjs list                          列出活跃 worktree
  worktree.mjs ports   <task-id>             查看端口分配

示例:
  worktree.mjs create sprint-N-<feature>     # 基于 HEAD 创建
  worktree.mjs create sprint-N-<feature> develop  # 基于 develop 创建
  cd .worktrees/sprint-N-<feature> && pnpm dev    # 在 worktree 中开发
  worktree.mjs destroy sprint-N-<feature>    # 清理`);
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'create':
    cmdCreate(rest[0], rest[1]);
    break;
  case 'destroy':
    cmdDestroy(rest[0]);
    break;
  case 'list':
    cmdList();
    break;
  case 'ports':
    cmdPorts(rest[0]);
    break;
  case 'help':
  default:
    showHelp();
    break;
}
