#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Secrets Scanner (CICD.md)
//
// 扫描仓库内可能泄露的 secret 字面值；与 ESLint harness/no-hardcoded-secrets 互补。
// 本脚本覆盖：所有文件类型（.env、yaml、md、sh、json…），ESLint 仅覆盖 JS/TS。
//
// 用法:
//   secrets-scan.mjs scan [--root .] [--ignore .git,node_modules]
//   secrets-scan.mjs check-cross-env       # 校验 secret 名称跨环境不复用
// =============================================================================

import { info, ok, err, fatal, existsSync, findFiles, readText, loadYaml } from './lib/utils.mjs';
import { loadEnvironmentsCompat } from './lib/deploy-config.mjs';

const DEFAULT_IGNORES = ['.git', 'node_modules', '.worktrees', 'dist', 'build', 'state'];

const PATTERNS = [
  { name: 'api-key', re: /(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?([A-Za-z0-9+/=_\-]{16,})["']?/gi },
  { name: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private-key', re: /-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

function shouldScan(path) {
  if (DEFAULT_IGNORES.some(d => path.includes('/' + d + '/') || path.startsWith(d + '/'))) return false;
  if (/\.(png|jpg|jpeg|gif|pdf|zip|tar|gz|ico|woff2?|ttf|mp4)$/i.test(path)) return false;
  // 锁文件、示例模板、测试 fixture 一律放行
  if (/\.(lock|lockb)$/i.test(path)) return false;
  if (/\.example$/i.test(path)) return false;
  if (/\/__fixtures__\//.test(path) || /\/fixtures\//.test(path)) return false;
  return true;
}

function scan(root = '.') {
  const files = findFiles(root, (p) => shouldScan(p), { skipDirs: DEFAULT_IGNORES });
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readText(f); } catch { continue; }
    for (const p of PATTERNS) {
      const re = new RegExp(p.re.source, p.re.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        const sample = m[0];
        if (/<.+>|\$\{.+\}|x{8,}|placeholder|EXAMPLE/i.test(sample)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        hits.push({ file: f, line, kind: p.name, sample: sample.slice(0, 80) });
      }
    }
  }
  if (hits.length) {
    err(`发现 ${hits.length} 处疑似 secret 字面值：`);
    for (const h of hits) console.error(`  ${h.file}:${h.line} [${h.kind}] ${h.sample}`);
    process.exit(1);
  }
  ok('未发现疑似 secret');
}

function checkCrossEnv() {
  const path = '.env.dev.example';
  if (!existsSync(path)) { info(`${path} 不存在；跳过跨环境名称检查`); return; }
  const lines = readText(path).split('\n').filter(l => /^HARNESS_/.test(l));
  const names = lines.map(l => l.split('=')[0]);
  const errors = [];
  for (const n of names) {
    // 期望前缀：HARNESS_DEV_*；不应在 dev 文件中出现 TEST/PROD 名称
    if (!n.startsWith('HARNESS_DEV_')) errors.push(`${n} 出现在 dev 模板中，但前缀不是 HARNESS_DEV_`);
  }
  // v1.6+ 校验 deploy.yml（兼容旧 environments.yml）secrets_source 与命名前缀一致
  if (existsSync('config/deploy.yml') || existsSync('config/environments.yml')) {
    const cfg = loadEnvironmentsCompat();
    for (const env of ['test', 'prod']) {
      const src = cfg?.environments?.[env]?.secrets_source;
      if (src && !/(:test|:prod|local-env-file|vault)/.test(src)) {
        errors.push(`environments.${env}.secrets_source 格式可疑：${src}`);
      }
    }
  }
  if (errors.length) {
    err('跨环境检查失败：');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  ok('跨环境 secret 命名规范通过');
}

function vcsCliScan(root = '.') {
  // 扫 yaml/sh 中直接调用 gh / glab / git push 的位置（应改用 scripts/pr-adapter.mjs 等抽象层）。
  // CICD.md：禁止业务代码绕过适配器直连 VCS CLI。
  const scanExt = (f) => /\.(ya?ml|sh|bash)$/i.test(f);
  const allow = [
    'workflows/',         // 流水线本身
    'scripts/lib/',
    'scripts/pr-adapter.mjs',
    'scripts/back-merge.mjs',
    'scripts/release.mjs',
    'scripts/promote.mjs',
    'scripts/hotfix.mjs',
    'scripts/image-promote.mjs',
    'install.sh', 'install.ps1',
  ];
  const files = findFiles(root, (p) => scanExt(p) && !DEFAULT_IGNORES.some(d => p.includes('/' + d + '/')), { skipDirs: DEFAULT_IGNORES });
  const re = /\b(gh|glab)\s+(pr|mr|api|repo)\b|\bgit\s+push\b/g;
  const hits = [];
  for (const f of files) {
    if (allow.some(a => f.includes(a))) continue;
    let text; try { text = readText(f); } catch { continue; }
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ file: f, line, sample: m[0] });
    }
  }
  if (hits.length) {
    err(`发现 ${hits.length} 处直接 VCS CLI 调用（请改用 scripts/pr-adapter.mjs 等抽象层）：`);
    for (const h of hits) console.error(`  ${h.file}:${h.line} → ${h.sample}`);
    process.exit(1);
  }
  ok('未发现直连 VCS CLI 调用');
}

function showHelp() {
  console.log(`
Harness Secrets Scan

  secrets-scan.mjs scan [--root <dir>]
  secrets-scan.mjs check-cross-env
  secrets-scan.mjs vcs-cli-scan [--root <dir>]

详见 docs/SECRETS.md。
`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
}

switch (cmd) {
  case 'scan': scan(args.root || '.'); break;
  case 'check-cross-env': checkCrossEnv(); break;
  case 'vcs-cli-scan': vcsCliScan(args.root || '.'); break;
  case undefined:
  case '--help':
  case '-h': showHelp(); break;
  default: err(`未知子命令: ${cmd}`); showHelp(); process.exit(1);
}
