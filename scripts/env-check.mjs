#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Environment Config Validator (CICD.md)
//
// 校验 config/deploy.yml schema（兼容 legacy environments.yml）；为 preflight / deploy / promote 提供门禁。
//
// 用法:
//   env-check.mjs validate                    # 校验 schema（不要求真实 secret 值）
//   env-check.mjs validate --mode runtime --env test
//   env-check.mjs check <env>                 # 检查 env 是否 enabled
//   env-check.mjs print <env>                 # 打印 env 配置
// =============================================================================

import { info, ok, err, fatal, existsSync, loadYaml, warn } from './lib/utils.mjs';
import { analyzeRequiredSecrets } from './lib/required-secrets.mjs';
import { analyzeRuntimeTemplate } from './lib/runtime-template.mjs';
import { loadEnvironmentsCompat } from './lib/deploy-config.mjs';
import { loadLocalRuntimeEnvSnapshot } from './lib/local-runtime-env.mjs';
import { expectedSecretsSource, loadSecretsFileSnapshot } from './lib/secrets-file.mjs';

// v1.6+ 真源：config/deploy.yml；env-check 通过 deploy-config loader 读取，自动兼容旧 environments.yml。
const PATH = existsSync('config/deploy.yml') ? 'config/deploy.yml' : 'config/environments.yml';

const SCHEMA = {
  test: ['enabled', 'deploy_target', 'remote_workdir', 'compose_file', 'remote_compose_file', 'remote_runtime_env_file', 'health_url', 'secrets_source'],
  prod: ['enabled', 'deploy_target', 'remote_workdir', 'compose_file', 'remote_compose_file', 'remote_runtime_env_file', 'health_url', 'secrets_source',
    'health_window_minutes', 'rollback_strategy', 'rollback_thresholds'],
};

const REQUIRED_DEPLOY_INPUTS = {
  test: ['TEST_DEPLOY_USER', 'TEST_DEPLOY_HOST', 'TEST_DEPLOY_PORT', 'TEST_DEPLOY_WORKDIR', 'TEST_API_BASE_URL'],
  prod: ['PROD_DEPLOY_USER', 'PROD_DEPLOY_HOST', 'PROD_DEPLOY_PORT', 'PROD_DEPLOY_WORKDIR', 'PROD_API_BASE_URL'],
};

function runtimeTemplatePath(entry) {
  if (!entry?.compose_file || typeof entry.compose_file !== 'string') return '';
  return entry.compose_file.replace(/docker-compose\.ya?ml$/, 'runtime.env.example');
}

function load() {
  if (!existsSync(PATH)) fatal(`未找到 ${PATH}（参考 config/deploy.yml.example 或 docs/CICD.md）`);
  const cfg = loadEnvironmentsCompat();
  if (cfg?.version !== 1) fatal(`${PATH}: version 必须为 1`);
  return cfg;
}

function isSecretProvided(secretName, envMap = process.env) {
  if (envMap[secretName]) return true;
  if (!/_SSH_PRIVATE_KEY$/.test(secretName)) return false;
  const sshKeyPath = envMap.HARNESS_SSH_KEY_PATH?.trim();
  return Boolean(sshKeyPath && existsSync(sshKeyPath));
}

export function collectValidationIssues(cfg, envMap = process.env, options = {}) {
  const schemaErrors = [];
  const secretErrors = [];
  const warnings = [];
  const requireSecrets = options.requireSecrets !== false;
  const onlyEnv = options.env;

  if (!['manual', 'train'].includes(cfg.promote_strategy)) {
    schemaErrors.push(`promote_strategy 必须是 manual 或 train，当前：${cfg.promote_strategy}`);
  }

  for (const env of Object.keys(SCHEMA)) {
    if (onlyEnv && env !== onlyEnv) continue;
    const entry = cfg.environments?.[env];
    if (!entry) {
      schemaErrors.push(`environments.${env} 缺失`);
      continue;
    }
    if (!entry.enabled) continue;

    for (const key of SCHEMA[env]) {
      if (entry[key] === undefined || entry[key] === '') {
        schemaErrors.push(`environments.${env}.${key} 缺失或为空`);
      }
    }
    const expectedSource = expectedSecretsSource(env);
    if (entry.secrets_source && entry.secrets_source !== expectedSource) {
      schemaErrors.push(`environments.${env}.secrets_source 必须为 ${expectedSource}，当前：${entry.secrets_source}`);
    }
    if (typeof entry.deploy_target === 'string' && !entry.deploy_target.startsWith('ssh://')) {
      schemaErrors.push(`environments.${env}.deploy_target 必须使用 ssh:// 目标声明`);
    }
    if (typeof entry.compose_file === 'string' && !entry.compose_file.startsWith(`deploy/${env}/`)) {
      schemaErrors.push(`environments.${env}.compose_file 必须指向 deploy/${env}/ 资产`);
    }
    if (typeof entry.remote_compose_file === 'string' && !entry.remote_compose_file.startsWith(`deploy/${env}/`)) {
      schemaErrors.push(`environments.${env}.remote_compose_file 必须指向 deploy/${env}/ 资产`);
    }
    if (typeof entry.remote_runtime_env_file === 'string' && !entry.remote_runtime_env_file.startsWith(`deploy/${env}/`)) {
      schemaErrors.push(`environments.${env}.remote_runtime_env_file 必须指向 deploy/${env}/runtime.env`);
    }

    const resolved = analyzeRequiredSecrets(env, entry);
    schemaErrors.push(...resolved.schemaErrors);
    warnings.push(...resolved.warnings);

    const missingInputs = REQUIRED_DEPLOY_INPUTS[env].filter((name) => !resolved.secrets.includes(name));
    if (missingInputs.length) {
      schemaErrors.push(`environments.${env}.resolved_secrets 缺少部署输入：${missingInputs.join(', ')}`);
    }

    if (requireSecrets) {
      const missingSecrets = resolved.secrets.filter((name) => !isSecretProvided(name, envMap));
      if (missingSecrets.length) {
        secretErrors.push(`environments.${env} 缺少 secret：${missingSecrets.join(', ')}`);
      }
    }

    const templatePath = options.runtimeTemplates?.[env] || runtimeTemplatePath(entry);
    if (templatePath) {
      if (!existsSync(templatePath) && !options.runtimeTemplateContent?.[env]) {
        schemaErrors.push(`environments.${env}.runtime_template 未找到：${templatePath}`);
      } else {
        const templateResult = analyzeRuntimeTemplate(env, templatePath, {
          envMap,
          declaredSecrets: resolved.secrets,
          template: options.runtimeTemplateContent?.[env],
          allowLocalRuntimeFileFallback: !requireSecrets,
        });
        for (const item of templateResult.missingSources) {
          schemaErrors.push(
            `environments.${env}.runtime_template ${templatePath}:${item.line} ${item.key} 为空且无配置来源（声明 ${item.candidates.join(' 或 ')}，或在 runtime 模板提供默认值）`,
          );
        }
      }
    }

    if (env === 'prod') {
      const thresholds = entry.rollback_thresholds || {};
      for (const key of ['error_rate_5xx', 'p95_latency_ms', 'cpu_saturation']) {
        if (typeof thresholds[key] !== 'number') {
          schemaErrors.push(`environments.prod.rollback_thresholds.${key} 必须为数字`);
        }
      }
    }
  }

  return { schemaErrors, secretErrors, warnings };
}

function parseValidateOptions(argv) {
  const out = { mode: 'schema', env: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') out.mode = argv[++i];
    else if (argv[i] === '--env') out.env = argv[++i];
  }
  if (!['schema', 'runtime'].includes(out.mode)) fatal(`--mode 必须为 schema 或 runtime，当前：${out.mode}`);
  if (out.env && !SCHEMA[out.env]) fatal(`--env 必须为 ${Object.keys(SCHEMA).join('|')}，当前：${out.env}`);
  return out;
}

function validate(argv = []) {
  const validateOptions = parseValidateOptions(argv);
  const cfg = load();
  const runtimeSecretErrors = [];
  const runtimeEnvMap = validateOptions.mode === 'runtime' ? { ...process.env } : {};
  if (validateOptions.mode === 'runtime') {
    Object.assign(runtimeEnvMap, loadLocalRuntimeEnvSnapshot().values);
    for (const env of Object.keys(SCHEMA)) {
      if (validateOptions.env && env !== validateOptions.env) continue;
      const entry = cfg.environments?.[env];
      if (!entry?.enabled) continue;
      const required = analyzeRequiredSecrets(env, entry).secrets;
      const snapshot = loadSecretsFileSnapshot(env, required);
      if (!snapshot.exists) {
        runtimeSecretErrors.push(`environments.${env} secrets 文件不存在：${expectedSecretsSource(env)}（先运行 node scripts/promote-prep.mjs ${env} 生成模板）`);
        continue;
      }
      if (snapshot.error) {
        runtimeSecretErrors.push(`environments.${env} secrets 文件无法加载：${snapshot.path}（${snapshot.error}）`);
        continue;
      }
      Object.assign(runtimeEnvMap, snapshot.values);
    }
  }
  const { schemaErrors, secretErrors, warnings } = collectValidationIssues(
    cfg,
    runtimeEnvMap,
    {
      requireSecrets: validateOptions.mode === 'runtime',
      env: validateOptions.env,
    },
  );
  for (const message of warnings) warn(message);
  if (schemaErrors.length) {
    err('environments.yml schema/配置错误：');
    for (const message of schemaErrors) console.error('  - ' + message);
  }
  if (secretErrors.length) {
    err(`${PATH} runtime secret 缺失（请补全 .harness/secrets/<env>.sh）：`);
    for (const message of secretErrors) console.error('  - ' + message);
  }
  if (runtimeSecretErrors.length) {
    err(`${PATH} runtime secrets 文件错误：`);
    for (const message of runtimeSecretErrors) console.error('  - ' + message);
  }
  if (schemaErrors.length || secretErrors.length || runtimeSecretErrors.length) {
    process.exit(1);
  }
  ok(`${PATH} ${validateOptions.mode} 校验通过`);
}

function check(env) {
  const cfg = load();
  const e = cfg.environments?.[env];
  if (!e?.enabled) {
    info(`${env}: 未启用（enabled=false）`);
    process.exit(2); // 2 = 跳过
  }
  ok(`${env}: 已启用`);
}

function print(env) {
  const cfg = load();
  const e = cfg.environments?.[env];
  if (!e) fatal(`environments.${env} 不存在`);
  console.log(JSON.stringify(e, null, 2));
}

function showHelp() {
  console.log(`
Harness Env Check

  env-check.mjs validate [--mode schema|runtime] [--env test|prod]
  env-check.mjs check <env>
  env-check.mjs print <env>

详见 docs/CICD.md。
`);
}

import { pathToFileURL } from 'node:url';
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isMain) {
  const [, , cmd, env, ...rest] = process.argv;
  switch (cmd) {
    case 'validate': validate([env, ...rest].filter(Boolean)); break;
    case 'check': if (!env) fatal('env 必填'); check(env); break;
    case 'print': if (!env) fatal('env 必填'); print(env); break;
    case undefined:
    case '--help':
    case '-h': showHelp(); break;
    default: err(`未知子命令: ${cmd}`); showHelp(); process.exit(1);
  }
}
