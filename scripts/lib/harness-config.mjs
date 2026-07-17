// Harness 框架级配置加载器
// 真源：config/harness.yml
// 调用方：sprint-gate / quality-score / promote-prep / task-rules 派生

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import yaml from 'js-yaml';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = process.env.HARNESS_CONFIG_PATH
  || path.resolve(__dirname, '..', '..', 'config', 'harness.yml');

const DEFAULTS = Object.freeze({
  version: 1,
  walkthrough_env: 'development',
  gates: {
    ui_design_l3: false,
    quality_threshold: 95,
  },
  deploy: {
    test_mode: 'docker',
    prod_mode: 'docker',
  },
});

const SCHEMA = {
  walkthrough_env: { type: 'enum', values: ['development', 'test'] },
  'gates.ui_design_l3': { type: 'boolean' },
  'gates.quality_threshold': { type: 'integer', min: 1, max: 100 },
  'deploy.test_mode': { type: 'enum', values: ['docker', 'cloud-native'] },
  'deploy.prod_mode': { type: 'enum', values: ['docker', 'cloud-native'] },
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(override)) {
    const bv = base?.[key];
    const ov = override[key];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && ov && typeof ov === 'object') {
      out[key] = deepMerge(bv, ov);
    } else {
      out[key] = ov;
    }
  }
  return out;
}

function getByPath(obj, keyPath) {
  return keyPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export function validate(config) {
  const errors = [];
  for (const [keyPath, rule] of Object.entries(SCHEMA)) {
    const v = getByPath(config, keyPath);
    if (v === undefined || v === null) {
      errors.push(`${keyPath}: 缺失`);
      continue;
    }
    if (rule.type === 'enum' && !rule.values.includes(v)) {
      errors.push(`${keyPath}: 值 "${v}" 不在 [${rule.values.join('|')}] 之内`);
    }
    if (rule.type === 'boolean' && typeof v !== 'boolean') {
      errors.push(`${keyPath}: 应为 boolean，实际 ${typeof v}`);
    }
    if (rule.type === 'integer') {
      if (!Number.isInteger(v)) errors.push(`${keyPath}: 应为整数`);
      else if (rule.min !== undefined && v < rule.min) errors.push(`${keyPath}: 不小于 ${rule.min}`);
      else if (rule.max !== undefined && v > rule.max) errors.push(`${keyPath}: 不大于 ${rule.max}`);
    }
  }
  return errors;
}

let cache = null;

export function loadHarnessConfig({ force = false } = {}) {
  if (cache && !force) return cache;

  let userConfig = {};
  let source = 'defaults';

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      userConfig = yaml.load(raw) || {};
      source = CONFIG_PATH;
    } catch (err) {
      throw new Error(`harness.yml 解析失败 (${CONFIG_PATH}): ${err.message}`);
    }
  }

  const merged = deepMerge(DEFAULTS, userConfig);
  const errors = validate(merged);
  if (errors.length) {
    throw new Error(`harness.yml 校验失败:\n  - ${errors.join('\n  - ')}`);
  }

  cache = Object.freeze({ ...merged, _source: source });
  return cache;
}

export function assertDeployModeImplemented(mode, env) {
  if (mode === 'docker') return;
  if (mode === 'cloud-native') {
    throw new Error(
      `deploy.${env}_mode = "cloud-native" 当前未实现。请在 config/harness.yml 改为 "docker"，` +
      `或在框架升级支持 cloud-native 后重试。`
    );
  }
  throw new Error(`未知部署模式: ${mode}`);
}

export const HARNESS_CONFIG_PATH = CONFIG_PATH;
export const HARNESS_DEFAULTS = DEFAULTS;
