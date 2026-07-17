#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// Harness Engineering — Secrets Sync Check (CICD.md)
//
// 校验 config/deploy.yml 的 secrets_source 是否收敛到 .harness/secrets/<env>.sh。
// 若本地 secrets 文件存在，则附带校验其 shell 语法可加载；不要求仓库内必须存在真实文件。
//
// 用法:
//   secrets-sync-check.mjs                # 校验所有环境
// =============================================================================

import { info, ok, err, fatal, existsSync } from './lib/utils.mjs';
import { loadEnvironmentsCompat } from './lib/deploy-config.mjs';
import { resolveRequiredSecrets } from './lib/required-secrets.mjs';
import { expectedSecretsSource, loadSecretsFileSnapshot } from './lib/secrets-file.mjs';

const cfgPath = existsSync('config/deploy.yml') ? 'config/deploy.yml' : 'config/environments.yml';
if (!existsSync(cfgPath)) fatal('config/deploy.yml 不存在（legacy config/environments.yml 也不存在）');
const cfg = loadEnvironmentsCompat();

let problems = 0;
for (const [env, entry] of Object.entries(cfg.environments || {})) {
  if (!entry?.enabled) continue;
  const expectedPath = expectedSecretsSource(env);
  if (entry.secrets_source !== expectedPath) {
    err(`environments.${env}.secrets_source 必须为 ${expectedPath}，当前：${entry.secrets_source}`);
    problems++;
  }
  const required = resolveRequiredSecrets(env, entry);
  if (required.length === 0) {
    err(`environments.${env} 未解析出 required secrets`);
    problems++;
    continue;
  }
  const snapshot = loadSecretsFileSnapshot(env, required);
  if (snapshot.exists && snapshot.error) {
    err(`${snapshot.path} 无法加载：${snapshot.error}`);
    problems++;
  }
  if (!snapshot.exists) {
    info(`${expectedPath} 尚不存在（允许）；promote-prep 将按 ${cfgPath} 自动生成模板`);
  }
}

if (problems > 0) {
  err(`secrets-sync-check 发现 ${problems} 个问题`);
  process.exit(1);
}
ok(`secrets-sync-check 通过：${cfgPath} 的 secrets_source 已收敛到 .harness/secrets/<env>.sh`);
