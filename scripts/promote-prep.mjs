#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — promote-prep
//
// 部署 Sprint / 任务前置：检查 + 补全发布信息，确认环境就绪。
//
// 流程：
//   1. 加载 config/deploy.yml + config/harness.yml
//   2. 校验目标 env 节点（enabled / deploy_target / health_url / required_secrets）
//   3. 根据 deploy_mode 检查/生成部署产物：
//        docker        → deploy/<env>/docker-compose.yml 必须存在
//        cloud-native  → 当前未实现，显式拒绝
//   4. 调用 env-check 校验 required_secrets 与 runtime 模板
//   5. 通过则写入 .harness/state/promote-prep-<env>.json，exit 0
//      失败则列出缺失项，exit 1
//
// 用法：
//   promote-prep.mjs <env>          # env: test | prod
//   promote-prep.mjs <env> --strict # 缺失即 fatal（默认）
// =============================================================================

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import yaml from 'js-yaml';
import { info, ok, err, fatal, warn } from './lib/utils.mjs';
import { loadDeployConfig, getEnvironment, loadBuildTargetsCompat } from './lib/deploy-config.mjs';
import { loadHarnessConfig, assertDeployModeImplemented } from './lib/harness-config.mjs';
import { analyzeRequiredSecrets } from './lib/required-secrets.mjs';
import { loadLocalRuntimeEnvSnapshot } from './lib/local-runtime-env.mjs';
import { ensureSecretsFile, loadSecretsFileSnapshot } from './lib/secrets-file.mjs';
import { collectValidationIssues } from './env-check.mjs';

const STATE_DIR = '.harness/state';

function writeState(env, payload) {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = `${STATE_DIR}/promote-prep-${env}.json`;
  writeFileSync(file, JSON.stringify({ ...payload, ts: new Date().toISOString() }, null, 2) + '\n');
  return file;
}

function generateComposeStub(envName, entry, composeFile) {
  let build;
  try { build = loadBuildTargetsCompat(); }
  catch { build = { targets: { app: {} }, image_repo: 'TODO-REPO' }; }
  const services = {};
  for (const [name, def] of Object.entries(build.targets || { app: {} })) {
    services[name] = {
      image: `${build.image_repo || 'TODO-REPO'}-${name}:\${IMAGE_TAG}`,
      restart: 'unless-stopped',
      env_file: [`.env.${envName}`],
      ...(def.ports ? { ports: def.ports } : {}),
    };
  }
  mkdirSync(dirname(composeFile), { recursive: true });
  writeFileSync(composeFile,
    `# AUTO-GENERATED stub by promote-prep.mjs (${new Date().toISOString()})\n` +
    `# 编辑此文件以补全 networks / volumes / depends_on / healthcheck\n` +
    yaml.dump({ version: '3.8', services }));
  warn(`已生成 docker-compose stub: ${composeFile}`);
}

function checkComposeFile(envName, entry, harness) {
  const mode = entry.deploy_mode || harness.deploy?.[`${envName}_mode`] || 'docker';
  assertDeployModeImplemented(mode, envName);
  if (mode !== 'docker') return { mode, ok: true, issues: [] };

  const issues = [];
  const composeFile = entry.compose_file || `deploy/${envName}/docker-compose.yml`;
  if (!existsSync(composeFile)) {
    generateComposeStub(envName, entry, composeFile);
    issues.push(`首次生成 ${composeFile} stub — 请按项目情况补全后重跑 promote-prep`);
  } else {
    const content = readFileSync(composeFile, 'utf8');
    if (!/^services\s*:/m.test(content)) {
      issues.push(`${composeFile} 不是合法 docker-compose（缺 services: 段）`);
    }
  }
  return { mode, ok: issues.length === 0, issues, composeFile };
}

function checkEnvEntry(envName, entry) {
  const issues = [];
  if (!entry.enabled) issues.push(`environments.${envName}.enabled = false`);
  for (const key of ['deploy_target', 'remote_workdir', 'health_url', 'secrets_source']) {
    if (!entry[key]) issues.push(`environments.${envName}.${key} 缺失`);
  }
  const secrets = analyzeRequiredSecrets(envName, entry);
  for (const message of secrets.schemaErrors) issues.push(message);
  if (secrets.secrets.length === 0) {
    issues.push(`environments.${envName}.resolved_secrets 为空`);
  }
  return issues;
}

function main() {
  const argv = process.argv.slice(2);
  const env = argv[0];
  if (!env || !['test', 'prod'].includes(env)) {
    err('用法: promote-prep.mjs <test|prod>');
    process.exit(2);
  }

  info(`==========================================`);
  info(` promote-prep: ${env}`);
  info(`==========================================`);

  const deploy = loadDeployConfig();
  const harness = loadHarnessConfig();
  const entry = (() => {
    try { return getEnvironment(env); }
    catch (e) { fatal(e.message); }
  })();

  const issues = [];

  const envIssues = checkEnvEntry(env, entry);
  for (const i of envIssues) issues.push({ kind: 'env-config', detail: i });

  const requiredSecrets = analyzeRequiredSecrets(env, entry).secrets;
  const secretsFile = ensureSecretsFile(env, requiredSecrets);
  if (secretsFile.created) {
    issues.push({
      kind: 'secret-file',
      detail: `已生成 ${secretsFile.path} 模板；请填写后重跑 promote-prep`,
    });
  }
  const secretsSnapshot = loadSecretsFileSnapshot(env, requiredSecrets);
  if (!secretsSnapshot.exists) {
    issues.push({
      kind: 'secret-file',
      detail: `${secretsFile.path} 不存在；请填写后重跑 promote-prep`,
    });
  } else if (secretsSnapshot.error) {
    issues.push({
      kind: 'secret-file',
      detail: `${secretsSnapshot.path} 无法加载：${secretsSnapshot.error}`,
    });
  }
  const validation = collectValidationIssues(
    deploy,
    { ...process.env, ...loadLocalRuntimeEnvSnapshot().values, ...secretsSnapshot.values },
    { env, requireSecrets: true },
  );
  for (const i of validation.schemaErrors) issues.push({ kind: 'schema', detail: i });
  for (const i of validation.secretErrors) issues.push({ kind: 'secret', detail: i });
  for (const i of validation.warnings) warn(i);

  let composeResult;
  try {
    composeResult = checkComposeFile(env, entry, harness);
    for (const i of composeResult.issues) issues.push({ kind: 'compose', detail: i });
  } catch (e) {
    issues.push({ kind: 'deploy-mode', detail: e.message });
    composeResult = { mode: entry.deploy_mode || 'unknown', ok: false, issues: [e.message] };
  }

  const stateFile = writeState(env, {
    env,
    enabled: !!entry.enabled,
    deploy_mode: composeResult.mode,
    compose_file: composeResult.composeFile,
    required_secrets: requiredSecrets,
    secrets_file: secretsFile.path,
    health_url: entry.health_url,
    issues,
    ready: issues.length === 0,
  });

  if (issues.length > 0) {
    err(`promote-prep 未通过（${issues.length} 项需修复）：`);
    for (const i of issues) console.error(`  - [${i.kind}] ${i.detail}`);
    err('修复后重跑：node scripts/promote-prep.mjs ' + env);
    err(`详细状态：${stateFile}`);
    process.exit(1);
  }

  ok(`promote-prep ${env} 通过 → ${stateFile}`);
  info(`  deploy_mode = ${composeResult.mode}`);
  info(`  compose     = ${composeResult.composeFile}`);
  info(`  secrets     = ${secretsFile.path}`);
  info(`  health      = ${entry.health_url}`);
}

main();
