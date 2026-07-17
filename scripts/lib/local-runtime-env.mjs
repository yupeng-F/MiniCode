// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Local Runtime Env Loader
//
// 业务运行时配置沿用项目本地 env 文件（默认 src/.env，或 verify.config.sh::ENV_FILE）。
// 部署密钥与 SSH 入口不在这里，统一走 .harness/secrets/<env>.sh。
// =============================================================================

import { existsSync, readText, resolve } from './utils.mjs';

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeRawValue(value) {
  if (value.startsWith('="') || value.startsWith('=\'')) {
    return value.slice(1);
  }
  return value;
}

export function parseEnvFileContent(content) {
  const values = {};
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = rawLine.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = normalizeRawValue(match[2]);
    const quote = value.startsWith('"') ? '"' : value.startsWith('\'') ? '\'' : '';
    if (quote && !value.endsWith(quote)) {
      while (index + 1 < lines.length) {
        index += 1;
        value += `\n${lines[index]}`;
        if (lines[index].endsWith(quote)) break;
      }
    }
    values[match[1]] = stripQuotes(value);
  }
  return values;
}

function resolveVerifyConfigEnvFile() {
  if (!existsSync('verify.config.sh')) return '';
  const content = readText('verify.config.sh');
  const match = content.match(/^ENV_FILE=(?:"([^"]+)"|'([^']+)'|([^\n#]+))/m);
  const raw = match?.[1] || match?.[2] || match?.[3] || '';
  if (!raw) return '';
  return raw.trim();
}

export function resolveLocalRuntimeEnvFiles() {
  const files = [];
  const fromEnv = process.env.HARNESS_RUNTIME_ENV_FILE?.trim();
  if (fromEnv) files.push(fromEnv);
  const fromVerify = resolveVerifyConfigEnvFile();
  if (fromVerify) files.push(fromVerify);
  files.push('src/.env', '.env');
  return [...new Set(files)]
    .map((file) => resolve(file))
    .filter((file) => existsSync(file));
}

export function loadLocalRuntimeEnvSnapshot() {
  const files = resolveLocalRuntimeEnvFiles();
  const values = {};
  for (const file of files) {
    Object.assign(values, parseEnvFileContent(readText(file)));
  }
  return { files, values };
}

export function applyLocalRuntimeEnvToProcessEnv() {
  const snapshot = loadLocalRuntimeEnvSnapshot();
  for (const [name, value] of Object.entries(snapshot.values)) {
    process.env[name] = value;
  }
  return snapshot;
}
