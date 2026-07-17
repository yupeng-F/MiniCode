#!/usr/bin/env node
/* eslint-disable harness/no-sql-concatenation */
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Deploy Orchestrator (CICD.md)
// =============================================================================

import { info, ok, err, fatal, warn, run, tryRun, existsSync, readText, writeText, loadYaml, mkdirSync } from './lib/utils.mjs';
import { resolveDeliveryMode } from './lib/delivery-mode.mjs';
import { applyLocalRuntimeEnvToProcessEnv } from './lib/local-runtime-env.mjs';
import { resolveRequiredSecrets } from './lib/required-secrets.mjs';
import { buildRuntimeMap, renderRuntimeFile } from './lib/runtime-template.mjs';
import { getEnvironment } from './lib/deploy-config.mjs';
import { applySecretsToProcessEnv, expectedSecretsSource } from './lib/secrets-file.mjs';
import { execSync } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_HEALTH_TIMEOUT_SECONDS = 180;
const WATCH_SAMPLE_INTERVAL_SECONDS = 30;
const DRY_RUN_TAG = '<dry-run>';
// REGISTRY_MODES: 校验在 lib/delivery-mode.mjs 内由 VALID_MODES 接管；保留集合以备本地引用。
const REGISTRY_MODES = new Set(['registry', 'artifact']);
void REGISTRY_MODES;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function loadEnvConfig(env) {
  // v1.6+ 通过 deploy-config loader 统一读取（config/deploy.yml 优先，回退 environments.yml）
  let entry;
  try {
    entry = getEnvironment(env);
  } catch (e) {
    fatal(e.message);
  }
  if (!entry.enabled) fatal(`environments.${env}.enabled=false：未配置则不执行部署`);
  applyLocalRuntimeEnvToProcessEnv();
  const snapshot = applySecretsToProcessEnv(env, resolveRequiredSecrets(env, entry));
  if (!snapshot.exists) {
    fatal(`未找到 ${expectedSecretsSource(env)}；先运行 node scripts/promote-prep.mjs ${env} 生成并填写 secrets 文件`);
  }
  if (snapshot.error) {
    fatal(`${snapshot.path} 无法加载：${snapshot.error}`);
  }
  return entry;
}

function placeholderValue(name) {
  switch (name) {
    case 'TEST_DEPLOY_PORT':
    case 'PROD_DEPLOY_PORT':
      return '22';
    case 'TEST_DEPLOY_USER':
    case 'PROD_DEPLOY_USER':
      return 'placeholder-user';
    case 'TEST_DEPLOY_HOST':
    case 'PROD_DEPLOY_HOST':
      return 'placeholder.example.internal';
    case 'TEST_DEPLOY_WORKDIR':
    case 'PROD_DEPLOY_WORKDIR':
      return `/srv/${name.toLowerCase()}`;
    case 'TEST_API_BASE_URL':
    case 'PROD_API_BASE_URL':
      return `https://placeholder.example.internal/${name.toLowerCase()}`;
    default:
      return `placeholder-${name.toLowerCase()}`;
  }
}

function resolveTemplate(value, options = {}) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const resolved = process.env[name];
    if (!resolved) {
      if (options.allowMissing) return placeholderValue(name);
      fatal(`缺少配置模板变量：${name}`);
    }
    return resolved;
  });
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function parseDeployTarget(rawTarget) {
  if (!rawTarget) fatal('deploy_target 未配置');
  let target;
  try {
    target = new URL(rawTarget);
  } catch (error) {
    fatal(`deploy_target 非法：${rawTarget}（${error.message}）`);
  }
  if (target.protocol !== 'ssh:') fatal(`deploy_target 仅支持 ssh://，当前：${rawTarget}`);
  if (!target.username || !target.hostname) fatal(`deploy_target 必须同时包含 user 与 host：${rawTarget}`);
  return {
    user: decodeURIComponent(target.username),
    host: target.hostname,
    port: target.port || '22',
  };
}

function getComposePaths(entry, options = {}) {
  const localComposeFile = entry.compose_file;
  const remoteComposeFile = resolveTemplate(entry.remote_compose_file || entry.compose_file, options);
  const remoteRuntimeEnvFile = resolveTemplate(entry.remote_runtime_env_file || remoteComposeFile.replace(/docker-compose\.ya?ml$/, 'runtime.env'), options);
  const remoteWorkdir = resolveTemplate(entry.remote_workdir, options);
  const localRuntimeTemplate = localComposeFile.replace(/docker-compose\.ya?ml$/, 'runtime.env.example');
  if (!remoteWorkdir) fatal('remote_workdir 未配置');
  if (!localComposeFile || !existsSync(localComposeFile)) fatal(`未找到 compose 文件：${localComposeFile}`);
  if (!existsSync(localRuntimeTemplate)) fatal(`未找到 runtime 模板：${localRuntimeTemplate}`);
  return { localComposeFile, remoteComposeFile, remoteRuntimeEnvFile, remoteWorkdir, localRuntimeTemplate };
}

function getRequiredSecrets(env, entry) {
  return resolveRequiredSecrets(env, entry);
}

function preflightSecrets(env, options = {}) {
  const entry = loadEnvConfig(env);
  info(`检查 ${env} secrets 完整性 (source=${entry.secrets_source})`);
  if (!entry.secrets_source) fatal(`environments.${env}.secrets_source 未填`);
  const required = getRequiredSecrets(env, entry);
  if (required.length === 0) {
    warn(`environments.${env} 未解析出 required secrets；跳过名称校验（建议补全）`);
    return [];
  }
  const missing = required.filter((name) => !isSecretSatisfied(env, name));
  if (missing.length && !options.allowMissing) fatal(`缺少必需 secret 环境变量：${missing.join(', ')}`);
  if (!missing.includes(getSshKeyEnvName(env))) validateSshKeyInput(env);
  if (missing.length) {
    warn(`preflight-secrets：缺少 ${missing.length} 个环境变量（dry-run 仅提示）`);
    return missing;
  }
  ok(`preflight-secrets：${required.length} 个 secret 全部就位`);
  return [];
}

function resolveRegistryMode(entry, options = {}) {
  // Sprint 12 T-04/T-05：HARNESS_DELIVERY_MODE 优先，旧名 stderr warn，默认 'artifact'。
  // 函数名保留为 resolveRegistryMode 以兼容 deploy-helpers.test.mjs 与 deploy.mjs 内部调用。
  return resolveDeliveryMode(entry);
}

export { resolveRegistryMode, resolveRemotePath, buildRuntimeMap, renderRuntimeFile, resolveSshKeyInput, createSshContext };

function resolveImageTars(options = {}) {
  const cli = options.imageTarArg ? String(options.imageTarArg).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const fromEnv = (process.env.HARNESS_IMAGE_TARS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const named = ['HARNESS_IMAGE_TAR_API', 'HARNESS_IMAGE_TAR_WEB']
    .map((key) => process.env[key])
    .filter(Boolean);
  const merged = [...cli, ...fromEnv, ...named];
  // 去重保持顺序
  return [...new Set(merged)];
}

function getSshKeyEnvName(env) {
  return `${env.toUpperCase()}_SSH_PRIVATE_KEY`;
}

function looksLikeInlinePrivateKey(value) {
  return typeof value === 'string'
    && (value.includes('\n') || /BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(value));
}

function resolveSshKeyInput(env) {
  const envVar = getSshKeyEnvName(env);
  const harnessPath = process.env.HARNESS_SSH_KEY_PATH?.trim();
  if (harnessPath) {
    return { kind: 'path', value: harnessPath, source: 'HARNESS_SSH_KEY_PATH', envVar };
  }
  const rawValue = process.env[envVar];
  if (!rawValue) {
    return { kind: 'missing', value: '', source: envVar, envVar };
  }
  const trimmed = rawValue.trim();
  if (trimmed && existsSync(trimmed)) {
    return { kind: 'path', value: trimmed, source: envVar, envVar };
  }
  if (looksLikeInlinePrivateKey(rawValue)) {
    return { kind: 'inline', value: rawValue, source: envVar, envVar };
  }
  return {
    kind: 'invalid',
    value: trimmed,
    source: envVar,
    envVar,
    reason: `${envVar} 既不是可读文件路径，也不是合法 PEM/OpenSSH 私钥内容`,
  };
}

function isSecretSatisfied(env, name) {
  const value = process.env[name];
  if (value && value !== '') return true;
  if (name === getSshKeyEnvName(env)) {
    return resolveSshKeyInput(env).kind !== 'missing';
  }
  return false;
}

function validateSshPrivateKeyFile(path, source) {
  if (!existsSync(path)) {
    fatal(`${source} 指向的 SSH 私钥文件不存在：${path}`);
  }
  let privateKey = '';
  try {
    privateKey = readText(path);
  } catch (error) {
    fatal(`${source} 指向的 SSH 私钥文件不可读：${path}（${error.message}）`);
  }
  if (!looksLikeInlinePrivateKey(privateKey)) {
    fatal(`${source} 指向的 SSH 私钥内容不是合法 PEM/OpenSSH 私钥：${path}`);
  }
  chmodSync(path, 0o600);
  const result = tryRun(`ssh-keygen -y -f ${shellEscape(path)}`, { timeout: 10_000 });
  if (!result.ok) {
    const detail = String(result.stderr || result.stdout || '').trim() || `exit=${result.exitCode}`;
    fatal(`${source} 指向的 SSH 私钥校验失败：${path}（${detail}）`);
  }
}

function validateSshKeyInput(env) {
  const resolved = resolveSshKeyInput(env);
  if (resolved.kind === 'missing') {
    fatal(`缺少 SSH 私钥入口：HARNESS_SSH_KEY_PATH 或 ${resolved.envVar}`);
  }
  if (resolved.kind === 'invalid') {
    fatal(resolved.reason);
  }
  if (resolved.kind === 'path') {
    validateSshPrivateKeyFile(resolved.value, resolved.source);
    return resolved;
  }
  const dir = '.harness/tmp';
  const path = join(dir, `${env}-ssh-validate.key`);
  mkdirSync(dir, { recursive: true });
  writeText(path, `${resolved.value.endsWith('\n') ? resolved.value : `${resolved.value}\n`}`);
  try {
    validateSshPrivateKeyFile(path, resolved.source);
    return resolved;
  } finally {
    rmSync(path, { force: true });
  }
}

function createSshContext(env, dryRun) {
  const sshCommon = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  const resolved = resolveSshKeyInput(env);
  if (resolved.kind === 'missing') {
    if (dryRun) return { sshOptions: sshCommon, cleanup: () => {} };
    fatal(`缺少 SSH 私钥入口：HARNESS_SSH_KEY_PATH 或 ${resolved.envVar}`);
  }
  if (resolved.kind === 'invalid') {
    fatal(resolved.reason);
  }
  const dir = '.harness/tmp';
  mkdirSync(dir, { recursive: true });
  let path = resolved.value;
  let cleanup = () => {};
  if (resolved.kind === 'inline') {
    path = join(dir, `${env}-deploy.key`);
    writeText(path, `${resolved.value.endsWith('\n') ? resolved.value : `${resolved.value}\n`}`);
    cleanup = () => rmSync(path, { force: true });
  }
  validateSshPrivateKeyFile(path, resolved.source);
  // ControlMaster: 复用同一条 TCP 连接，避免每个 ssh/scp 重新握手触发 sshd MaxStartups
  const ctlPath = join(dir, `${env}-cm-%C`);
  const muxOpts = [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${ctlPath}`,
    '-o', 'ControlPersist=120',
  ];
  return {
    sshOptions: [...sshCommon, '-i', path, ...muxOpts],
    cleanup,
  };
}

function buildPlan(env, tag, driver, options = {}) {
  const entry = loadEnvConfig(env);
  const paths = getComposePaths(entry, { allowMissing: !!options.dryRun });
  const target = parseDeployTarget(resolveTemplate(entry.deploy_target, { allowMissing: !!options.dryRun }));
  const { rendered, missing } = renderRuntimeFile(env, paths.localRuntimeTemplate, tag || DRY_RUN_TAG);
  const composeCmd = process.env.COMPOSE_CMD || 'docker compose';
  const healthUrl = entry.health_url ? resolveTemplate(entry.health_url, { allowMissing: !!options.dryRun }) : '';
  const smokeCmd = entry.smoke_cmd ? resolveTemplate(entry.smoke_cmd, { allowMissing: !!options.dryRun }) : '';
  const registryMode = resolveRegistryMode(entry, options);
  const imageTars = registryMode === 'artifact' ? resolveImageTars(options) : [];
  const remoteArtifactDir = resolveTemplate(entry.remote_artifact_dir || `${paths.remoteWorkdir}/.artifacts`, { allowMissing: !!options.dryRun });
  return {
    env,
    tag,
    driver,
    entry,
    paths,
    target,
    rendered,
    missing,
    composeCmd,
    healthUrl,
    smokeCmd,
    registryMode,
    imageTars,
    remoteArtifactDir,
    dryRun: !!options.dryRun,
  };
}

function printPlan(plan, title = 'deploy preflight') {
  info(`${title}: env=${plan.env} driver=${plan.driver} tag=${plan.tag || DRY_RUN_TAG} registry_mode=${plan.registryMode}`);
  info(`target: ssh://${plan.target.user}@${plan.target.host}:${plan.target.port}`);
  info(`remote_workdir: ${plan.paths.remoteWorkdir}`);
  info(`compose_file: ${plan.paths.remoteComposeFile}`);
  info(`runtime_env_file: ${plan.paths.remoteRuntimeEnvFile}`);
  info(`health_url: ${plan.healthUrl || '(none)'}`);
  info(`smoke_cmd: ${plan.smokeCmd || '(none)'}`);
  if (plan.registryMode === 'artifact') {
    info(`remote_artifact_dir: ${plan.remoteArtifactDir}`);
    if (plan.imageTars.length === 0) {
      warn('artifact 模式：未提供镜像 tar（--image-tar 或 HARNESS_IMAGE_TAR_*）');
    } else {
      info(`image_tars: ${plan.imageTars.join(', ')}`);
    }
  }
  if (plan.missing.length > 0) warn(`runtime 渲染缺少变量：${plan.missing.join(', ')}`);
}

function preflight(env, tag, driver = 'compose', options = {}) {
  const missingSecrets = preflightSecrets(env, { allowMissing: !!options.dryRun });
  const plan = buildPlan(env, tag, driver, { dryRun: options.dryRun, imageTarArg: options.imageTarArg });
  printPlan(plan, options.dryRun ? 'deploy preflight dry-run' : 'deploy preflight');
  if (options.dryRun) {
    process.stdout.write(plan.rendered);
    ok(`preflight(dry-run) 完成：${env}`);
    return;
  }
  if (missingSecrets.length > 0 || plan.missing.length > 0) {
    fatal(`preflight 未通过：缺少 secrets/runtime 变量`);
  }
  if (plan.registryMode === 'artifact' && plan.imageTars.length === 0) {
    fatal('preflight 未通过：artifact 模式需要至少一个镜像 tar');
  }
  ok(`preflight 完成：${env}`);
}

function resolveRemotePath(plan, p) {
  if (!p) return p;
  // Sprint 13 T-04：拒绝包含 ".." 段的路径以防越界（test: deploy-helpers.test.mjs）。
  const segments = p.split('/');
  if (segments.includes('..')) {
    throw new Error(`拒绝包含 .. 的远端路径：${p}`);
  }
  return p.startsWith('/') ? p : `${plan.paths.remoteWorkdir.replace(/\/$/, '')}/${p}`;
}

function writeRemoteRuntime(env, plan, sshContext) {
  const tempDir = '.harness/tmp';
  mkdirSync(tempDir, { recursive: true });
  const localPath = join(tempDir, `${env}.runtime.env`);
  writeText(localPath, plan.rendered);
  chmodSync(localPath, 0o600);
  const sshTarget = `${plan.target.user}@${plan.target.host}`;
  const sshOpts = [...sshContext.sshOptions, '-p', plan.target.port].map(shellEscape).join(' ');
  const scpOpts = [...sshContext.sshOptions, '-P', plan.target.port].map(shellEscape).join(' ');
  const remoteRuntimeAbs = resolveRemotePath(plan, plan.paths.remoteRuntimeEnvFile);
  const remoteComposeAbs = resolveRemotePath(plan, plan.paths.remoteComposeFile);
  const remoteRuntimeDir = dirname(remoteRuntimeAbs);
  const remoteComposeDir = dirname(remoteComposeAbs);
  try {
    const remoteSetup = `mkdir -p ${shellEscape(plan.paths.remoteWorkdir)} ${shellEscape(remoteRuntimeDir)} ${shellEscape(remoteComposeDir)}`;
    run(`ssh ${sshOpts} ${shellEscape(sshTarget)} ${shellEscape(remoteSetup)}`);
    run(`scp ${scpOpts} ${shellEscape(localPath)} ${shellEscape(`${sshTarget}:${remoteRuntimeAbs}`)}`);
    if (plan.paths.localComposeFile && existsSync(plan.paths.localComposeFile)) {
      info(`upload compose: ${plan.paths.localComposeFile} → ${remoteComposeAbs}`);
      run(`scp ${scpOpts} ${shellEscape(plan.paths.localComposeFile)} ${shellEscape(`${sshTarget}:${remoteComposeAbs}`)}`);
    }
  } finally {
    rmSync(localPath, { force: true });
  }
}

function uploadAndLoadArtifacts(plan, sshContext) {
  if (plan.imageTars.length === 0) {
    fatal('artifact 模式：未提供镜像 tar；请通过 --image-tar a.tar,b.tar 或 HARNESS_IMAGE_TAR_API/_WEB 指定');
  }
  const sshTarget = `${plan.target.user}@${plan.target.host}`;
  const sshOpts = [...sshContext.sshOptions, '-p', plan.target.port].map(shellEscape).join(' ');
  const scpOpts = [...sshContext.sshOptions, '-P', plan.target.port].map(shellEscape).join(' ');
  for (const tarPath of plan.imageTars) {
    if (!existsSync(tarPath)) fatal(`artifact 镜像 tar 不存在：${tarPath}`);
  }
  const ensureDir = `mkdir -p ${shellEscape(plan.remoteArtifactDir)}`;
  run(`ssh ${sshOpts} ${shellEscape(sshTarget)} ${shellEscape(ensureDir)}`);
  for (const tarPath of plan.imageTars) {
    const remoteTar = `${plan.remoteArtifactDir}/${tarPath.split('/').pop()}`;
    info(`upload artifact: ${tarPath} → ${remoteTar}`);
    run(`scp ${scpOpts} ${shellEscape(tarPath)} ${shellEscape(`${sshTarget}:${remoteTar}`)}`);
    const loadCmd = `docker load -i ${shellEscape(remoteTar)}`;
    run(`ssh ${sshOpts} ${shellEscape(sshTarget)} ${shellEscape(loadCmd)}`);
  }
  // 清理 7 天前 tar，避免磁盘累积
  const pruneCmd = `find ${shellEscape(plan.remoteArtifactDir)} -name '*.tar' -mtime +7 -delete || true`;
  run(`ssh ${sshOpts} ${shellEscape(sshTarget)} ${shellEscape(pruneCmd)}`);
}

function deployRemoteCompose(plan, sshContext) {
  const sshTarget = `${plan.target.user}@${plan.target.host}`;
  const sshOpts = [...sshContext.sshOptions, '-p', plan.target.port].map(shellEscape).join(' ');
  writeRemoteRuntime(plan.env, plan, sshContext);
  if (plan.registryMode === 'artifact') {
    uploadAndLoadArtifacts(plan, sshContext);
  }
  const remoteComposeCmd = `${plan.composeCmd} --env-file ${shellEscape(plan.paths.remoteRuntimeEnvFile)} -f ${shellEscape(plan.paths.remoteComposeFile)}`;
  const steps = [
    'set -euo pipefail',
    `cd ${shellEscape(plan.paths.remoteWorkdir)}`,
  ];
  if (plan.registryMode === 'registry') {
    steps.push(`${remoteComposeCmd} pull`);
  } else {
    steps.push(`echo 'registry_mode=artifact: skip compose pull'`);
  }
  steps.push(`${remoteComposeCmd} up -d --remove-orphans`);
  const remoteScript = steps.join('; ');
  run(`ssh ${sshOpts} ${shellEscape(sshTarget)} ${shellEscape(remoteScript)}`);
}

function deployLocalCompose(plan) {
  const runtimePath = plan.paths.localRuntimeTemplate.replace(/\.example$/, '');
  writeText(runtimePath, plan.rendered);
  run(`${plan.composeCmd} --env-file ${shellEscape(runtimePath)} -f ${shellEscape(plan.paths.localComposeFile)} pull`);
  run(`${plan.composeCmd} --env-file ${shellEscape(runtimePath)} -f ${shellEscape(plan.paths.localComposeFile)} up -d --remove-orphans`);
}

function deploy(env, tag, driver = 'compose', options = {}) {
  if (!tag) fatal('deploy 需要 --tag');
  const dryRun = !!options.dryRun;
  preflightSecrets(env, { allowMissing: dryRun });
  const plan = buildPlan(env, tag, driver, { dryRun, imageTarArg: options.imageTarArg });
  printPlan(plan, dryRun ? 'deploy dry-run' : 'deploy');
  if (plan.missing.length > 0 && !dryRun) fatal(`runtime 渲染缺少变量：${plan.missing.join(', ')}`);
  if (plan.registryMode === 'artifact' && plan.imageTars.length === 0 && !dryRun) {
    fatal('artifact 模式：未提供镜像 tar；请通过 --image-tar 或 HARNESS_IMAGE_TAR_* 指定');
  }
  if (dryRun) {
    ok(`${env} deploy(dry-run) 完成`);
    return;
  }
  switch (driver) {
    case 'compose': {
      const sshContext = createSshContext(env, false);
      try {
        deployRemoteCompose(plan, sshContext);
      } finally {
        sshContext.cleanup();
      }
      break;
    }
    case 'k8s':
      fatal('k8s driver 尚未实现（CICD.md Phase 2）');
      break;
    default:
      fatal(`未知 driver：${driver}`);
  }
  if (plan.healthUrl) {
    info(`等待 ${plan.healthUrl} 返回 200…`);
    waitForHealth(plan.healthUrl);
  }
  if (plan.smokeCmd) run(plan.smokeCmd);
  appendDeployLog({ kind: 'deploy', env, tag, ts: new Date().toISOString() });
  ok(`${env} 部署 + 冒烟完成`);
}

function sleepSync(seconds) {
  try {
    execSync(`sleep ${seconds}`);
  } catch {
    // ignore interruption
  }
}

function waitForHealth(url, timeoutSeconds = DEFAULT_HEALTH_TIMEOUT_SECONDS) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const result = tryRun(`curl -fsS -m 5 -o /dev/null -w "%{http_code}" ${url}`);
    if (result.ok && result.stdout.trim() === '200') {
      ok('health 200');
      return;
    }
    process.stdout.write('.');
    sleepSync(2);
  }
  fatal(`health 超时：${url}`);
}

function watch(env, windowStr, options = {}) {
  const entry = loadEnvConfig(env);
  const minutes = parseInt((windowStr || '30m').replace(/m$/, ''), 10);
  const healthUrl = resolveTemplate(entry.health_url, { allowMissing: !!options.dryRun });
  info(`观察 ${env} 健康窗口 ${minutes} 分钟（阈值见 environments.${env}.rollback_thresholds）`);
  if (options.dryRun) {
    info(`watch dry-run: url=${healthUrl} interval=${WATCH_SAMPLE_INTERVAL_SECONDS}s`);
    ok(`${env} watch(dry-run) 完成`);
    return;
  }
  const start = Date.now();
  let okHits = 0;
  while (Date.now() - start < minutes * 60_000) {
    const result = tryRun(`curl -fsS -m 5 -o /dev/null -w "%{http_code}" ${healthUrl}`);
    if (!result.ok || result.stdout.trim() !== '200') {
      err('健康检查失败 → 触发自动回滚');
      rollback(env, { dryRun: false });
      process.exit(1);
    }
    okHits += 1;
    sleepSync(WATCH_SAMPLE_INTERVAL_SECONDS);
  }
  ok(`${env}: ${minutes} 分钟健康窗口通过（${okHits} 次采样）`);
}

function resolveRollbackTag(env) {
  const logPath = '.harness/state/promotion-log.yml';
  if (!existsSync(logPath)) return { error: '.harness/state/promotion-log.yml 不存在，无历史可回滚' };
  const text = readText(logPath);
  const tags = [...text.matchAll(/\n  kind: deploy[\s\S]*?\n  env: (\S+)[\s\S]*?\n  tag: (\S+)/g)]
    .filter((match) => match[1] === env)
    .map((match) => match[2]);
  if (tags.length < 2) return { error: `环境 ${env} 历史 deploy 记录不足（${tags.length}）` };
  return { tag: tags[tags.length - 2] };
}

function rollback(env, options = {}) {
  const entry = loadEnvConfig(env);
  warn(`rollback ${env}（策略=${entry.rollback_strategy || 'image-revert'}）`);
  const projectHook = 'scripts/rollback.mjs';
  if (existsSync(projectHook) && !options.dryRun) {
    info(`委托项目实现：${projectHook}`);
    run(`node ${projectHook} --env ${env}`);
    return;
  }
  const resolved = resolveRollbackTag(env);
  if (resolved.error) {
    if (options.dryRun) {
      warn(`rollback dry-run: ${resolved.error}`);
      return;
    }
    err(`rollback 失败：${resolved.error}`);
    err(`提示：人工 deploy.mjs --env ${env} --tag <prev-tag>`);
    process.exit(1);
  }
  warn(`rollback → 上一稳定 tag：${resolved.tag}`);
  if (options.dryRun) {
    ok(`${env} rollback(dry-run) 完成`);
    return;
  }
  deploy(env, resolved.tag, 'compose', { dryRun: false });
  appendDeployLog({ kind: 'rollback', env, tag: resolved.tag, ts: new Date().toISOString() });
}

function appendDeployLog(entry) {
  const path = '.harness/state/promotion-log.yml';
  const previous = existsSync(path) ? readText(path) : 'log:\n';
  const head = previous.startsWith('log:\n') ? previous : `log:\n${previous}`;
  const line = `- kind: ${entry.kind}\n  env: ${entry.env}\n  tag: ${entry.tag}\n  ts: ${entry.ts}\n`;
  writeText(path, `${head}${line}`);
}

function showHelp() {
  console.log(`
Harness Deploy

  deploy.mjs --env <dev|test|prod> --tag <image-tag> [--driver compose|k8s] [--dry-run] [--image-tar a.tar,b.tar]
  deploy.mjs preflight --env <env> --tag <image-tag> [--driver compose|k8s] [--dry-run] [--image-tar ...]
  deploy.mjs preflight-secrets --env <env>
  deploy.mjs watch --env <env> --window 30m [--dry-run]
  deploy.mjs rollback --env <env> [--dry-run]

环境变量：
  HARNESS_DELIVERY_MODE   registry|artifact（默认 artifact；artifact 走 scp+docker load）
  HARNESS_IMAGE_TARS      逗号分隔 tar 路径（与 --image-tar 等价）
  HARNESS_IMAGE_TAR_API   单独指定 api 镜像 tar
  HARNESS_IMAGE_TAR_WEB   单独指定 web 镜像 tar

详见 docs/CICD.md。
`);
}

// 仅当作为脚本直接执行时跑 CLI；被测试 import 时不副作用。
import { pathToFileURL } from 'node:url';
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const argv = process.argv.slice(2);
  const [first] = argv;
  const args = parseArgs(argv);

  if (!first || first === '--help' || first === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (first) {
    case 'preflight-secrets':
      preflightSecrets(args.env);
      break;
    case 'preflight':
      preflight(args.env, args.tag, args.driver || 'compose', { dryRun: !!args['dry-run'], imageTarArg: args['image-tar'] });
      break;
    case 'watch':
      watch(args.env, args.window, { dryRun: !!args['dry-run'] });
      break;
    case 'rollback':
      rollback(args.env, { dryRun: !!args['dry-run'] });
      break;
    default:
      if (!args.env || !args.tag) fatal('需要 --env 与 --tag');
      deploy(args.env, args.tag, args.driver || 'compose', { dryRun: !!args['dry-run'], imageTarArg: args['image-tar'] });
      break;
  }
}
