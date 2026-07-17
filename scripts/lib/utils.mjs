// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — 脚本共享工具库
// =============================================================================

import { execSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, readdirSync,
  statSync, mkdirSync, rmSync, lstatSync,
} from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

// ─── Colors ──────────────────────────────────────────────────────────────────

const isColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => isColor ? `\x1b[${code}m${s}\x1b[0m` : s;
export const C = {
  red: c('31'), green: c('32'), yellow: c('33'), cyan: c('36'), bold: c('1'),
};

// ─── Logging ─────────────────────────────────────────────────────────────────

const TAG = C.cyan('[harness]');
export function info(msg)  { console.log(`${TAG} ${msg}`); }
export function ok(msg)    { console.log(`${C.green('✅')} ${msg}`); }
export function warn(msg)  { console.error(`${C.yellow('⚠️')}  ${msg}`); }
export function err(msg)   { console.error(`${C.red('❌')} ${msg}`); }
export function fatal(msg) { err(msg); process.exit(1); }

// ─── Command Execution ──────────────────────────────────────────────────────

/** Run a command, return stdout. Throws on failure unless ignoreError. */
export function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: opts.silent ? 'pipe' : 'inherit',
      timeout: opts.timeout,
      cwd: opts.cwd,
    });
  } catch (e) {
    if (opts.ignoreError) return e.stdout || '';
    throw e;
  }
}

/** Run a command, capture and return trimmed stdout. */
export function runCapture(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8', stdio: 'pipe',
      timeout: opts.timeout, cwd: opts.cwd,
    }).trim();
  } catch (e) {
    if (opts.ignoreError) return (e.stdout || '').trim();
    throw e;
  }
}

/** Check if a command exists on PATH. */
export function hasCmd(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

/** Run a command, return { ok, stdout, stderr, exitCode }. Never throws. */
export function tryRun(cmd, opts = {}) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', cwd: opts.cwd, timeout: opts.timeout });
    return { ok: true, stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
  }
}

// ─── YAML ────────────────────────────────────────────────────────────────────

/** Load and parse a YAML file. Returns the parsed object. */
export function loadYaml(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  return yaml.load(content);
}

// ─── File System ─────────────────────────────────────────────────────────────

/** Recursively find files matching a predicate. */
export function findFiles(dir, predicate, opts = {}) {
  const results = [];
  if (!existsSync(dir)) return results;
  const maxDepth = opts.maxDepth ?? Infinity;

  function walk(d, depth) {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (opts.skipDirs?.includes(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (predicate(full, entry.name)) results.push(full);
      }
    }
  }

  walk(dir, 0);
  return results;
}

/** Read a text file, return its content. */
export function readText(filePath) {
  return readFileSync(filePath, 'utf-8');
}

/** Write text to a file, creating directories as needed. */
export function writeText(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export function gitRoot() {
  return runCapture('git rev-parse --show-toplevel');
}

// ─── Project Root ────────────────────────────────────────────────────────────

/** Resolve project root from the scripts/ directory (one level up). */
export function projectRoot(importMetaUrl) {
  const scriptDir = dirname(fileURLToPath(importMetaUrl));
  return resolve(scriptDir, '..');
}

// ─── Arg Parsing (lightweight) ───────────────────────────────────────────────

/**
 * Parse CLI args into { flags: Set, options: Map, positional: string[] }.
 * flagDefs: ['--ci', '--fix', ...]
 * optionDefs: ['--threshold', '--report-dir', ...]
 */
export function parseArgs(argv, { flags: flagDefs = [], options: optionDefs = [] } = {}) {
  const flags = new Set();
  const options = new Map();
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagDefs.includes(arg)) {
      flags.add(arg);
    } else if (optionDefs.includes(arg)) {
      options.set(arg, argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      flags.add('--help');
    } else if (arg.startsWith('-')) {
      fatal(`未知参数: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { flags, options, positional };
}

// ─── Markdown Report ─────────────────────────────────────────────────────────

export function mdTable(headers, rows) {
  const sep = headers.map(() => '------');
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

export function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Re-export node:path and node:fs for convenience
export { join, resolve, dirname, basename, relative };
export { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, lstatSync, rmSync };
