// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Required Secrets Resolver (Sprint 12 T-02 / P1-#8)
//
// 框架内置基础设施 secret 模板 + 解析函数。
// 业务专属 secret 在项目 config/deploy.yml 通过 `extra_required_secrets:` 追加。
//
// Schema v2（自 Sprint 12）：
//   environments.<env>.extra_required_secrets: [<NAME>, ...]   # 项目业务追加
//
// Legacy（v1）兼容：
//   environments.<env>.required_secrets: [<NAME>, ...]         # 整表（包括基础设施）
//   - 仍然工作，但 warn 一次提示迁移
//   - 与 extra_required_secrets 同时声明 → fatal
// =============================================================================

import { warn, fatal } from './utils.mjs';

const BASE_TEMPLATE_COMMON = [
  'DEPLOY_USER', 'DEPLOY_HOST', 'DEPLOY_PORT', 'DEPLOY_WORKDIR',
  'API_BASE_URL', 'SSH_PRIVATE_KEY',
];

const BASE_TEMPLATE_PROD_EXTRA = ['REGISTRY_USERNAME', 'REGISTRY_PASSWORD'];

/**
 * 返回某环境的"框架内置基础设施 secret 名单"。
 * @param {string} envName  例如 'test' / 'prod'
 * @returns {string[]}      形如 ['TEST_DEPLOY_USER', ...]
 */
export function baseRequiredSecrets(envName) {
  if (!envName || typeof envName !== 'string') {
    fatal(`baseRequiredSecrets: envName 必须为非空字符串，实际：${envName}`);
  }
  const prefix = envName.toUpperCase();
  const list = BASE_TEMPLATE_COMMON.map((s) => `${prefix}_${s}`);
  if (envName === 'prod') {
    list.push(...BASE_TEMPLATE_PROD_EXTRA.map((s) => `${prefix}_${s}`));
  }
  return list;
}

/**
 * 合并基础设施 base + 项目 extra_required_secrets，返回去重后的最终 secret 列表。
 * 兼容旧字段 required_secrets（legacy 模式：整表使用 + warn）。
 *
 * @param {string} envName
 * @param {object} entry    config/deploy.yml 中 environments.<env> 节点
 * @returns {string[]}
 */
export function resolveRequiredSecrets(envName, entry) {
  if (!entry || typeof entry !== 'object') {
    fatal(`resolveRequiredSecrets: environments.${envName} 节点缺失或非对象`);
  }
  const result = analyzeRequiredSecrets(envName, entry);

  if (result.schemaErrors.length > 0) {
    fatal(
      result.schemaErrors.join('\n'),
    );
  }

  for (const message of result.warnings) {
    warn(message);
  }

  return result.secrets;
}

export function analyzeRequiredSecrets(envName, entry) {
  if (!entry || typeof entry !== 'object') {
    return {
      schemaErrors: [`resolveRequiredSecrets: environments.${envName} 节点缺失或非对象`],
      warnings: [],
      secrets: [],
    };
  }
  const hasLegacy = Array.isArray(entry.required_secrets) && entry.required_secrets.length > 0;
  const hasExtra = Array.isArray(entry.extra_required_secrets);
  if (hasLegacy && hasExtra) {
    return {
      schemaErrors: [
        `environments.${envName}: 不可同时声明 required_secrets 与 extra_required_secrets，请二选一（推荐 extra_required_secrets）`,
      ],
      warnings: [],
      secrets: [],
    };
  }
  if (hasLegacy) {
    return {
      schemaErrors: [],
      warnings: [
        `environments.${envName}.required_secrets 是 legacy (schema v1) 字段；建议迁移到 schema v2：删除并改用 extra_required_secrets 仅声明业务专属项，框架基础设施 secret 由 baseRequiredSecrets() 内置。`,
      ],
      secrets: [...entry.required_secrets],
    };
  }
  const extra = hasExtra ? entry.extra_required_secrets : [];
  return {
    schemaErrors: [],
    warnings: [],
    secrets: [...new Set([...baseRequiredSecrets(envName), ...extra])],
  };
}
