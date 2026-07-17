// Harness 部署配置加载器
//
// v1.6+ 真源：config/deploy.yml（合并 environments.yml + build-targets.yml）
// 兼容旧版：若 deploy.yml 不存在但 environments.yml/build-targets.yml 存在，
//   loader 在内存中合并并返回，同时 stderr 打印 deprecation 提示。
//
// install.sh 在安装时检测旧文件 + 缺 deploy.yml 时会写入合并后的 deploy.yml。
// 项目主动迁移完成后可删除旧文件。
//
// 任何脚本读取部署配置请通过本模块；禁止再 loadYaml('config/environments.yml')。

import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { loadHarnessConfig } from './harness-config.mjs';

const DEPLOY_PATH = process.env.DEPLOY_CONFIG_PATH || 'config/deploy.yml';
const LEGACY_ENV_PATH = 'config/environments.yml';
const LEGACY_BUILD_PATH = 'config/build-targets.yml';

let cached = null;

function readYaml(path) {
  return yaml.load(readFileSync(path, 'utf8')) || {};
}

function warn(msg) {
  // eslint-disable-next-line no-console
  console.error(`[deploy-config][warn] ${msg}`);
}

/**
 * 合并旧 environments.yml + build-targets.yml → 新 deploy.yml shape
 * @param {object} envCfg
 * @param {object|null} buildCfg
 * @returns {object}
 */
export function mergeLegacyConfig(envCfg, buildCfg) {
  const harness = (() => { try { return loadHarnessConfig(); } catch { return null; } })();
  const out = {
    version: envCfg.version || 1,
    promote_strategy: envCfg.promote_strategy || 'manual',
    train_schedule: envCfg.train_schedule || '0 17 * * 1-5',
    build: buildCfg
      ? {
          image_repo: buildCfg.image_repo,
          default_platform: buildCfg.default_platform || 'linux/amd64',
          artifact_dir: buildCfg.artifact_dir || '.harness/images',
          targets: buildCfg.targets || {},
        }
      : null,
    environments: {},
  };
  for (const [name, entry] of Object.entries(envCfg.environments || {})) {
    out.environments[name] = {
      ...entry,
      deploy_mode:
        entry.deploy_mode
        || (harness?.deploy?.[`${name}_mode`])
        || 'docker',
    };
  }
  return out;
}

/**
 * 读取 config/deploy.yml；若不存在则尝试合并旧 environments.yml + build-targets.yml。
 * @param {{force?: boolean}} opts
 * @returns {object}
 */
export function loadDeployConfig(opts = {}) {
  if (cached && !opts.force) return cached;

  if (existsSync(DEPLOY_PATH)) {
    cached = readYaml(DEPLOY_PATH);
    return cached;
  }

  if (!existsSync(LEGACY_ENV_PATH)) {
    throw new Error(
      `部署配置缺失：未找到 ${DEPLOY_PATH}（亦无 ${LEGACY_ENV_PATH} 可回退）。`
      + ` 复制 config/deploy.yml.example 到 config/deploy.yml 并填写。`,
    );
  }

  warn(`${DEPLOY_PATH} 不存在，回退到 ${LEGACY_ENV_PATH}`
    + (existsSync(LEGACY_BUILD_PATH) ? ` + ${LEGACY_BUILD_PATH}` : '')
    + '；建议手动 cp config/deploy.yml.example → config/deploy.yml 或重跑 install.sh 触发自动合成。');

  const envCfg = readYaml(LEGACY_ENV_PATH);
  const buildCfg = existsSync(LEGACY_BUILD_PATH) ? readYaml(LEGACY_BUILD_PATH) : null;
  cached = mergeLegacyConfig(envCfg, buildCfg);
  return cached;
}

/**
 * 取指定环境节点；不存在则抛错。
 */
export function getEnvironment(envName) {
  const cfg = loadDeployConfig();
  const entry = cfg.environments?.[envName];
  if (!entry) {
    throw new Error(`config/deploy.yml 中未声明 environments.${envName}`);
  }
  return entry;
}

/**
 * 兼容旧脚本：返回与 environments.yml 同形状（带 promote_strategy / train_schedule）。
 */
export function loadEnvironmentsCompat() {
  const cfg = loadDeployConfig();
  return {
    version: cfg.version,
    promote_strategy: cfg.promote_strategy,
    train_schedule: cfg.train_schedule,
    environments: cfg.environments,
  };
}

/**
 * 兼容旧脚本：返回与 build-targets.yml 同形状（image_repo / targets ...）。
 */
export function loadBuildTargetsCompat() {
  const cfg = loadDeployConfig();
  return cfg.build || {};
}

export function resetDeployConfigCache() { cached = null; }
