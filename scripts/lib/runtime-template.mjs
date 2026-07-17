// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Runtime Template Resolver
// =============================================================================

import { readText } from './utils.mjs';

export const RUNTIME_OPTIONAL_KEYS = new Set(['TEST_PUBLIC_BASE_URL', 'PROD_PUBLIC_BASE_URL']);

function parseDatabaseUrl(value) {
  if (!value) return {};
  try {
    const parsed = new URL(value);
    return {
      user: parsed.username || '',
      password: parsed.password || '',
      database: parsed.pathname.replace(/^\//, ''),
    };
  } catch {
    return {};
  }
}

function readEnv(envMap, key) {
  return envMap?.[key] || '';
}

function isLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').trim().toLowerCase());
}

function rewriteUrlHost(rawValue, nextHost) {
  if (!rawValue) return '';
  try {
    const parsed = new URL(rawValue);
    if (!isLoopbackHost(parsed.hostname)) return rawValue;
    parsed.hostname = nextHost;
    return parsed.toString();
  } catch {
    return rawValue;
  }
}

function rewriteKafkaBrokers(rawValue) {
  if (!rawValue) return '';
  return rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, ...rest] = entry.split(':');
      if (!isLoopbackHost(host)) return entry;
      return `kafka:${rest.join(':') || '9092'}`;
    })
    .join(',');
}

export function deriveImageRepositories(projectPrefix = '', envMap = process.env) {
  const repo = readEnv(envMap, 'HARNESS_IMAGE_REPO');
  const prefix = projectPrefix ? `${projectPrefix}_` : '';
  return {
    api: readEnv(envMap, `${prefix}API_IMAGE_REPOSITORY`) || (repo ? `${repo}-api` : ''),
    web: readEnv(envMap, `${prefix}WEB_IMAGE_REPOSITORY`) || (repo ? `${repo}-web` : ''),
  };
}

export function buildRuntimeMap(env, tag, envMap = process.env) {
  const prefix = `${env.toUpperCase()}_`;
  const databaseUrl = rewriteUrlHost(readEnv(envMap, `${prefix}DATABASE_URL`) || readEnv(envMap, 'DATABASE_URL'), 'postgres');
  const redisUrl = rewriteUrlHost(readEnv(envMap, `${prefix}REDIS_URL`) || readEnv(envMap, 'REDIS_URL'), 'redis');
  const database = parseDatabaseUrl(databaseUrl);
  const publicBaseUrl = readEnv(envMap, `${prefix}PUBLIC_BASE_URL`);
  const apiBaseUrl = readEnv(envMap, `${prefix}API_BASE_URL`);
  return {
    [`${prefix}PUBLIC_BASE_URL`]: publicBaseUrl,
    [`${prefix}API_BASE_URL`]: apiBaseUrl,
    OAUTH_CALLBACK_URL: readEnv(envMap, 'OAUTH_CALLBACK_URL') || (publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/auth/callback` : (apiBaseUrl ? `${apiBaseUrl.replace(/\/$/, '')}/auth/callback` : '')),
    POSTGRES_USER: readEnv(envMap, 'POSTGRES_USER') || database.user || '',
    POSTGRES_PASSWORD: readEnv(envMap, 'POSTGRES_PASSWORD') || database.password || '',
    POSTGRES_DB: readEnv(envMap, 'POSTGRES_DB') || database.database || '',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    KAFKA_BROKERS: rewriteKafkaBrokers(readEnv(envMap, 'KAFKA_BROKERS')) || 'kafka:9092',
    MINIO_ROOT_USER: readEnv(envMap, 'MINIO_ROOT_USER') || readEnv(envMap, `${prefix}MINIO_ACCESS_KEY`) || readEnv(envMap, 'MINIO_ACCESS_KEY'),
    MINIO_ROOT_PASSWORD: readEnv(envMap, 'MINIO_ROOT_PASSWORD') || readEnv(envMap, `${prefix}MINIO_SECRET_KEY`) || readEnv(envMap, 'MINIO_SECRET_KEY'),
    MINIO_ENDPOINT: isLoopbackHost(readEnv(envMap, 'MINIO_ENDPOINT')) ? 'minio' : (readEnv(envMap, 'MINIO_ENDPOINT') || 'minio'),
    MINIO_PORT: readEnv(envMap, 'MINIO_PORT') || '9000',
    MINIO_ACCESS_KEY: readEnv(envMap, `${prefix}MINIO_ACCESS_KEY`) || readEnv(envMap, 'MINIO_ACCESS_KEY'),
    MINIO_SECRET_KEY: readEnv(envMap, `${prefix}MINIO_SECRET_KEY`) || readEnv(envMap, 'MINIO_SECRET_KEY'),
    MINIO_BUCKET: readEnv(envMap, 'MINIO_BUCKET'),
    MINIO_USE_SSL: readEnv(envMap, 'MINIO_USE_SSL') || 'false',
    MINIO_PUBLIC_BASE_URL: readEnv(envMap, `${prefix}MINIO_PUBLIC_BASE_URL`) || readEnv(envMap, 'MINIO_PUBLIC_BASE_URL'),
    JWT_SECRET: readEnv(envMap, `${prefix}JWT_SECRET`),
  };
}

export function resolveTemplateRuntimeValue(key, fallback, env, tag, runtimeMap, envMap = process.env) {
  if (runtimeMap[key] !== undefined && runtimeMap[key] !== '') return runtimeMap[key];
  const envPrefix = `${env.toUpperCase()}_`;
  const prefixed = envMap[`${envPrefix}${key}`];
  if (prefixed !== undefined) return prefixed;
  if (envMap[key] !== undefined) return envMap[key];
  if (/_IMAGE_TAG$/.test(key)) return tag || fallback;
  const apiRepoMatch = key.match(/^(.+)_API_IMAGE_REPOSITORY$/);
  if (apiRepoMatch) return deriveImageRepositories(apiRepoMatch[1], envMap).api || fallback;
  const webRepoMatch = key.match(/^(.+)_WEB_IMAGE_REPOSITORY$/);
  if (webRepoMatch) return deriveImageRepositories(webRepoMatch[1], envMap).web || fallback;
  return fallback;
}

export function quoteEnvValue(value) {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@=+\-,]+$/.test(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
  return `"${escaped}"`;
}

export function parseRuntimeTemplate(template) {
  return template.split('\n')
    .map((line, index) => ({ line, index: index + 1, match: line.match(/^([A-Z0-9_]+)=(.*)$/) }))
    .filter(({ match }) => match)
    .map(({ index, match }) => ({ line: index, key: match[1], fallback: match[2] }));
}

export function renderRuntimeFile(env, templatePath, tag, options = {}) {
  const envMap = options.envMap || process.env;
  const runtimeMap = buildRuntimeMap(env, tag, envMap);
  const template = readText(templatePath);
  const lines = template.split('\n');
  const missing = [];
  const rendered = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) return line;
    const key = match[1];
    const fallback = match[2];
    const value = resolveTemplateRuntimeValue(key, fallback, env, tag, runtimeMap, envMap);
    const resolved = value === undefined ? '' : String(value);
    if (!resolved && !RUNTIME_OPTIONAL_KEYS.has(key)) missing.push(key);
    return `${key}=${quoteEnvValue(resolved)}`;
  }).join('\n');
  return { rendered: `${rendered}\n`, missing };
}

function runtimeSourceCandidates(env, key) {
  const prefix = `${env.toUpperCase()}_`;
  const sources = key.startsWith(prefix)
    ? new Set([key])
    : new Set([`${prefix}${key}`, key]);
  switch (key) {
    case 'OAUTH_CALLBACK_URL':
      sources.add('OAUTH_CALLBACK_URL');
      sources.add(`${prefix}PUBLIC_BASE_URL`);
      sources.add(`${prefix}API_BASE_URL`);
      break;
    case 'POSTGRES_USER':
    case 'POSTGRES_PASSWORD':
    case 'POSTGRES_DB':
      sources.add(key);
      sources.add(`${prefix}DATABASE_URL`);
      sources.add('DATABASE_URL');
      break;
    case 'DATABASE_URL':
      sources.add(`${prefix}DATABASE_URL`);
      break;
    case 'REDIS_URL':
      sources.add(`${prefix}REDIS_URL`);
      break;
    case 'MINIO_ROOT_USER':
    case 'MINIO_ACCESS_KEY':
      sources.add(`${prefix}MINIO_ACCESS_KEY`);
      sources.add('MINIO_ROOT_USER');
      sources.add('MINIO_ACCESS_KEY');
      break;
    case 'MINIO_ROOT_PASSWORD':
    case 'MINIO_SECRET_KEY':
      sources.add(`${prefix}MINIO_SECRET_KEY`);
      sources.add('MINIO_ROOT_PASSWORD');
      sources.add('MINIO_SECRET_KEY');
      break;
    case 'MINIO_PUBLIC_BASE_URL':
      sources.add(`${prefix}MINIO_PUBLIC_BASE_URL`);
      sources.add('MINIO_PUBLIC_BASE_URL');
      break;
    case 'JWT_SECRET':
      sources.add(`${prefix}JWT_SECRET`);
      break;
    default:
      break;
  }
  return [...sources];
}

function isImageRuntimeKey(key) {
  return /_IMAGE_TAG$/.test(key)
    || /^.+_API_IMAGE_REPOSITORY$/.test(key)
    || /^.+_WEB_IMAGE_REPOSITORY$/.test(key);
}

export function analyzeRuntimeTemplate(env, templatePath, options = {}) {
  const envMap = options.envMap || process.env;
  const declaredSecrets = new Set(options.declaredSecrets || []);
  const allowLocalRuntimeFileFallback = options.allowLocalRuntimeFileFallback === true;
  const tag = options.tag || '<validate>';
  const template = options.template ?? readText(templatePath);
  const runtimeMap = buildRuntimeMap(env, tag, envMap);
  const missingSources = [];

  for (const entry of parseRuntimeTemplate(template)) {
    if (entry.fallback !== '' || RUNTIME_OPTIONAL_KEYS.has(entry.key) || isImageRuntimeKey(entry.key)) continue;
    const resolved = resolveTemplateRuntimeValue(entry.key, entry.fallback, env, tag, runtimeMap, envMap);
    if (resolved !== undefined && String(resolved) !== '') continue;
    const candidates = runtimeSourceCandidates(env, entry.key);
    const hasDeclaredSource = candidates.some((name) => declaredSecrets.has(name));
    const hasProvidedSource = candidates.some((name) => envMap[name] !== undefined && envMap[name] !== '');
    const hasLocalRuntimeFileCandidate = allowLocalRuntimeFileFallback
      && candidates.some((name) => !name.startsWith(`${env.toUpperCase()}_`));
    if (!hasDeclaredSource && !hasProvidedSource && !hasLocalRuntimeFileCandidate) {
      missingSources.push({ ...entry, candidates });
    }
  }

  return { missingSources };
}
