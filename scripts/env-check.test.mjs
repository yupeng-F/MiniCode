import test from 'node:test';
import assert from 'node:assert/strict';

import { baseRequiredSecrets } from './lib/required-secrets.mjs';
import { collectValidationIssues } from './env-check.mjs';

function buildEnv(secretNames) {
  return Object.fromEntries(secretNames.map((name) => [name, `${name.toLowerCase()}-value`]));
}

function buildLocalRuntimeEnv() {
  return buildEnv(['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY']);
}

function collect(cfg, envMap, options = {}) {
  return collectValidationIssues(cfg, { ...buildLocalRuntimeEnv(), ...envMap }, {
    runtimeTemplateContent: {
      test: [
        'TEST_DEPLOY_USER=',
        'TEST_DEPLOY_HOST=',
        'TEST_DEPLOY_PORT=22',
        'TEST_DEPLOY_WORKDIR=',
        'TEST_API_BASE_URL=',
        'DATABASE_URL=',
        'REDIS_URL=',
        'JWT_SECRET=',
        'MINIO_ACCESS_KEY=',
        'MINIO_SECRET_KEY=',
        '',
      ].join('\n'),
    },
    ...options,
  });
}

function baseConfig() {
  return {
    version: 1,
    promote_strategy: 'manual',
    environments: {
      test: {
        enabled: true,
        deploy_target: 'ssh://${TEST_DEPLOY_USER}@${TEST_DEPLOY_HOST}:${TEST_DEPLOY_PORT}',
        remote_workdir: '${TEST_DEPLOY_WORKDIR}',
        compose_file: 'deploy/test/docker-compose.yml',
        remote_compose_file: 'deploy/test/docker-compose.yml',
        remote_runtime_env_file: 'deploy/test/runtime.env',
        health_url: '${TEST_API_BASE_URL}/health',
        secrets_source: '.harness/secrets/test.sh',
      },
      prod: {
        enabled: false,
      },
    },
  };
}

test('collectValidationIssues: extra_required_secrets 会被 validate 识别', () => {
  const cfg = baseConfig();
  cfg.environments.test.extra_required_secrets = ['TEST_WECOM_CONFIG_MASTER_KEY'];
  const envMap = buildEnv([...baseRequiredSecrets('test'), 'TEST_WECOM_CONFIG_MASTER_KEY']);
  const result = collect(cfg, envMap);

  assert.deepEqual(result.schemaErrors, []);
  assert.deepEqual(result.secretErrors, []);
  assert.deepEqual(result.warnings, []);
});

test('collectValidationIssues: legacy required_secrets 兼容并给出告警', () => {
  const cfg = baseConfig();
  cfg.environments.test.required_secrets = [...baseRequiredSecrets('test'), 'TEST_WECOM_CONFIG_MASTER_KEY'];
  const envMap = buildEnv(cfg.environments.test.required_secrets);
  const result = collect(cfg, envMap);

  assert.deepEqual(result.schemaErrors, []);
  assert.deepEqual(result.secretErrors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /legacy .*字段/);
});

test('collectValidationIssues: 双字段冲突归类为 schema/配置错误', () => {
  const cfg = baseConfig();
  cfg.environments.test.required_secrets = [...baseRequiredSecrets('test')];
  cfg.environments.test.extra_required_secrets = ['TEST_WECOM_CONFIG_MASTER_KEY'];
  const envMap = buildEnv([...baseRequiredSecrets('test'), 'TEST_WECOM_CONFIG_MASTER_KEY']);
  const result = collect(cfg, envMap);

  assert.ok(result.schemaErrors.some((message) => message.includes('不可同时声明 required_secrets 与 extra_required_secrets')));
});

test('collectValidationIssues: secret 缺失单独归类', () => {
  const cfg = baseConfig();
  cfg.environments.test.extra_required_secrets = ['TEST_WECOM_CONFIG_MASTER_KEY'];
  const envMap = buildEnv(baseRequiredSecrets('test'));
  const result = collect(cfg, envMap);

  assert.deepEqual(result.schemaErrors, []);
  assert.equal(result.secretErrors.length, 1);
  assert.match(result.secretErrors[0], /TEST_WECOM_CONFIG_MASTER_KEY/);
});

test('collectValidationIssues: schema 模式不要求真实 secret 值', () => {
  const cfg = baseConfig();
  cfg.environments.test.extra_required_secrets = ['TEST_WECOM_CONFIG_MASTER_KEY'];
  const result = collect(cfg, {}, { requireSecrets: false });

  assert.deepEqual(result.schemaErrors, []);
  assert.deepEqual(result.secretErrors, []);
});

test('collectValidationIssues: HARNESS_SSH_KEY_PATH 必须指向存在的文件', () => {
  const cfg = baseConfig();
  cfg.environments.test.extra_required_secrets = [];
  const envMap = buildEnv(baseRequiredSecrets('test').filter(name => name !== 'TEST_SSH_PRIVATE_KEY'));
  envMap.HARNESS_SSH_KEY_PATH = '/path/that/does/not/exist';

  const result = collect(cfg, envMap);

  assert.deepEqual(result.schemaErrors, []);
  assert.equal(result.secretErrors.length, 1);
  assert.match(result.secretErrors[0], /TEST_SSH_PRIVATE_KEY/);
});

test('collectValidationIssues: runtime 模板空变量必须有声明来源', () => {
  const cfg = baseConfig();
  cfg.environments.test.extra_required_secrets = [];
  const envMap = buildEnv(baseRequiredSecrets('test'));

  const result = collect(cfg, envMap, {
    runtimeTemplates: { test: 'deploy/test/runtime.env.example' },
    runtimeTemplateContent: { test: 'SERVICE_TOKEN=\n' },
  });

  assert.ok(result.schemaErrors.some((message) => message.includes('SERVICE_TOKEN') && message.includes('TEST_SERVICE_TOKEN')));
});

test('collectValidationIssues: runtime 模板空变量可由项目 extra_required_secrets 声明', () => {
  const cfg = baseConfig();
  cfg.environments.test.extra_required_secrets = ['TEST_SERVICE_TOKEN'];
  const envMap = buildEnv([...baseRequiredSecrets('test'), 'TEST_SERVICE_TOKEN']);

  const result = collect(cfg, envMap, {
    runtimeTemplates: { test: 'deploy/test/runtime.env.example' },
    runtimeTemplateContent: { test: 'SERVICE_TOKEN=\n' },
  });

  assert.deepEqual(result.schemaErrors, []);
  assert.deepEqual(result.secretErrors, []);
});

test('collectValidationIssues: runtime 模板默认值由项目模板定义，不要求 secret', () => {
  const cfg = baseConfig();
  cfg.environments.test.extra_required_secrets = [];
  const envMap = buildEnv(baseRequiredSecrets('test'));

  const result = collect(cfg, envMap, {
    runtimeTemplates: { test: 'deploy/test/runtime.env.example' },
    runtimeTemplateContent: { test: 'AUTH_MODE=password-login\n' },
  });

  assert.deepEqual(result.schemaErrors, []);
});
