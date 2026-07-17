// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Local Secrets Shell File
//
// 运行时部署密钥唯一真源：.harness/secrets/<env>.sh
// - promote-prep 负责首次生成模板
// - env-check / deploy 在运行时从该文件加载变量
// =============================================================================

import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

import { dirname, existsSync, mkdirSync, writeText } from './utils.mjs';

export function expectedSecretsSource(env) {
  return `.harness/secrets/${env}.sh`;
}

export function secretsFilePath(env) {
  if (!env || typeof env !== 'string') {
    throw new Error(`secretsFilePath: env 必须为非空字符串，实际：${env}`);
  }
  return expectedSecretsSource(env);
}

function renderPlaceholder(name) {
  if (/_DEPLOY_PORT$/.test(name)) return '22';
  return '';
}

export function renderSecretsTemplate(env, secretNames = []) {
  const file = secretsFilePath(env);
  const lines = [
    '#!/usr/bin/env bash',
    `# Harness runtime secrets for ${env}`,
    '# Fill real values locally and rerun promote-prep / deploy preflight.',
    '# This file is intentionally gitignored; do not commit real secrets.',
    '#',
    '# Multi-line SSH private key example:',
    `# export ${env.toUpperCase()}_SSH_PRIVATE_KEY="$(cat <<'EOF'`,
    '# -----BEGIN OPENSSH PRIVATE KEY-----',
    '# ...',
    '# -----END OPENSSH PRIVATE KEY-----',
    '# EOF',
    '# )"',
    '',
  ];
  for (const name of [...new Set(secretNames)]) {
    lines.push(`export ${name}='${renderPlaceholder(name)}'`);
  }
  lines.push('');
  return lines.join('\n');
}

export function ensureSecretsFile(env, secretNames = []) {
  const path = secretsFilePath(env);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeText(path, renderSecretsTemplate(env, secretNames));
    chmodSync(path, 0o600);
    return { path, created: true };
  }
  return { path, created: false };
}

export function loadSecretsFileSnapshot(env, secretNames = []) {
  const path = secretsFilePath(env);
  if (!existsSync(path)) {
    return { path, exists: false, values: {}, error: null };
  }
  const names = [...new Set([...secretNames, 'HARNESS_SSH_KEY_PATH'])];
  const script = `
set -a
source "$1"
shift
for name in "$@"; do
  value="\${!name-}"
  printf '%s=' "$name"
  printf '%s' "$value" | base64 | tr -d '\\n'
  printf '\\n'
done
`;
  try {
    const stdout = execFileSync('bash', ['-lc', script, 'bash', path, ...names], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const values = {};
    for (const rawLine of stdout.split('\n')) {
      if (!rawLine) continue;
      const index = rawLine.indexOf('=');
      if (index < 0) continue;
      const name = rawLine.slice(0, index);
      const encoded = rawLine.slice(index + 1);
      const value = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
      if (value !== '') values[name] = value;
    }
    return { path, exists: true, values, error: null };
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim();
    return {
      path,
      exists: true,
      values: {},
      error: detail || `无法加载 ${path}`,
    };
  }
}

export function applySecretsToProcessEnv(env, secretNames = []) {
  const snapshot = loadSecretsFileSnapshot(env, secretNames);
  if (!snapshot.exists || snapshot.error) return snapshot;
  for (const [name, value] of Object.entries(snapshot.values)) {
    process.env[name] = value;
  }
  return snapshot;
}
