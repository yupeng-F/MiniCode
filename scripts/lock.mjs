#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Environment Lock (CICD.md)
//
// 在 promote / release CD / hotfix 之间互斥访问 test 环境，避免并发部署冲突。
// 锁文件：.harness/state/<env>.lock；TTL 默认 7200 秒，过期自动失效。
//
// 用法:
//   lock.mjs acquire <env> --owner <id> [--ttl <seconds>]
//   lock.mjs release <env> --owner <id>
//   lock.mjs check <env>            # 退出码 0=空闲 / 1=占用
//   lock.mjs force-release <env>    # 仅人工介入
// =============================================================================

import { info, ok, err, fatal, existsSync, readText, writeText, join } from './lib/utils.mjs';
import { unlinkSync } from 'node:fs';

const STATE_DIR = '.harness/state';
const DEFAULT_TTL = 7200;

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

function lockPath(env) { return join(STATE_DIR, `${env}.lock`); }

function readLock(env) {
  const p = lockPath(env);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readText(p)); } catch { return null; }
}

function isExpired(l) {
  return Date.now() - new Date(l.acquired_at).getTime() > l.ttl_seconds * 1000;
}

function acquire(env, args) {
  if (!args.owner) fatal('--owner 必填');
  const ttl = parseInt(args.ttl || DEFAULT_TTL, 10);
  const cur = readLock(env);
  if (cur && !isExpired(cur)) {
    if (cur.owner === args.owner) {
      ok(`锁已被自己持有：${env} → ${cur.owner}`);
      return;
    }
    fatal(`环境 ${env} 已被 ${cur.owner} 持有（acquired_at=${cur.acquired_at}, ttl=${cur.ttl_seconds}s）`);
  }
  const lock = { env, owner: args.owner, acquired_at: new Date().toISOString(), ttl_seconds: ttl };
  writeText(lockPath(env), JSON.stringify(lock, null, 2) + '\n');
  ok(`已获取锁：${env} → ${args.owner}（TTL ${ttl}s）`);
}

function release(env, args) {
  if (!args.owner) fatal('--owner 必填');
  const cur = readLock(env);
  if (!cur) { info(`无锁可释放：${env}`); return; }
  if (cur.owner !== args.owner && !isExpired(cur)) {
    fatal(`只能由持有者释放，当前持有者：${cur.owner}`);
  }
  unlinkSync(lockPath(env));
  ok(`已释放锁：${env}`);
}

function check(env) {
  const cur = readLock(env);
  if (!cur) { console.log('free'); process.exit(0); }
  if (isExpired(cur)) { console.log(`expired ${cur.owner}`); process.exit(0); }
  console.log(`held ${cur.owner} acquired_at=${cur.acquired_at} ttl=${cur.ttl_seconds}s`);
  process.exit(1);
}

function owner(env) {
  // 仅输出 owner 字符串（空闲时输出空，退出 0）；供 workflow 解析。
  const cur = readLock(env);
  if (!cur || isExpired(cur)) { process.exit(0); }
  process.stdout.write(cur.owner);
}

function forceRelease(env) {
  if (!existsSync(lockPath(env))) { info('无锁'); return; }
  unlinkSync(lockPath(env));
  ok(`强制释放：${env}`);
}

function showHelp() {
  console.log(`
Harness Lock — 环境互斥锁

  lock.mjs acquire <env> --owner <id> [--ttl <seconds>]
  lock.mjs release <env> --owner <id>
  lock.mjs check <env>
  lock.mjs owner <env>           # 输出当前 owner（空闲时空字符串）
  lock.mjs force-release <env>

详见 docs/CICD.md。
`);
}

const [, , cmd, env, ...rest] = process.argv;
const args = parseArgs(rest);

switch (cmd) {
  case 'acquire': if (!env) fatal('env 必填'); acquire(env, args); break;
  case 'release': if (!env) fatal('env 必填'); release(env, args); break;
  case 'check': if (!env) fatal('env 必填'); check(env); break;
  case 'owner': if (!env) fatal('env 必填'); owner(env); break;
  case 'force-release': if (!env) fatal('env 必填'); forceRelease(env); break;
  case undefined:
  case '--help':
  case '-h': showHelp(); break;
  default: err(`未知子命令: ${cmd}`); showHelp(); process.exit(1);
}
