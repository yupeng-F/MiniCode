// scripts/deploy-helpers.test.mjs — Sprint 12 T-01
// 覆盖 deploy.mjs 中的纯函数（resolveRemotePath / checkRemoteComposeVersion 解析）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildRuntimeMap, createSshContext, renderRuntimeFile, resolveRemotePath, resolveRegistryMode, resolveSshKeyInput } from './deploy.mjs';

const plan = { paths: { remoteWorkdir: '/srv/example-app' } };
const TEST_SSH_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCtIRaPt1qwqD2Cs4YTPUgKA/nML5+ColrcCJjjE9YG+gAAAJg1eU2cNXlN
nAAAAAtzc2gtZWQyNTUxOQAAACCtIRaPt1qwqD2Cs4YTPUgKA/nML5+ColrcCJjjE9YG+g
AAAEAhEwTINcUy0b78xFbMxWsAlqBOCsRFq12S9n3YJFpdGq0hFo+3WrCoPYKzhhM9SAoD
+cwvn4KiWtwImOMT1gb6AAAAFXdzQHdzZGVNYWMtbWluaS5sb2NhbA==
-----END OPENSSH PRIVATE KEY-----
`;

test('resolveRemotePath: 相对路径拼 workdir', () => {
  assert.equal(resolveRemotePath(plan, 'a/b'), '/srv/example-app/a/b');
});

test('resolveRemotePath: 绝对路径透传', () => {
  assert.equal(resolveRemotePath(plan, '/etc/foo'), '/etc/foo');
});

test('resolveRemotePath: 含 .. 抛错', () => {
  assert.throws(() => resolveRemotePath(plan, 'a/../b'), /拒绝/);
  assert.throws(() => resolveRemotePath(plan, '../etc/passwd'), /拒绝/);
  assert.throws(() => resolveRemotePath(plan, '/srv/x/../../etc'), /拒绝/);
});

test('resolveRemotePath: 无 .. 段不误伤', () => {
  // ".." 仅整段才拒；"a..b" 这种文件名不触发
  assert.equal(resolveRemotePath(plan, 'a..b/c'), '/srv/example-app/a..b/c');
  assert.equal(resolveRemotePath(plan, '..foo/bar'), '/srv/example-app/..foo/bar');
});

test('resolveRemotePath: 空值透传', () => {
  assert.equal(resolveRemotePath(plan, ''), '');
  assert.equal(resolveRemotePath(plan, undefined), undefined);
});

// ─── Sprint 12 T-04 — resolveRegistryMode（HARNESS_DELIVERY_MODE 别名 + warn）──
function withEnv(env, fn) {
  const snapshot = {};
  const keys = [...new Set(['HARNESS_DELIVERY_MODE', 'HARNESS_REGISTRY_MODE', 'HARNESS_SSH_KEY_PATH', ...Object.keys(env)])];
  for (const k of keys) {
    snapshot[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return fn(); }
  finally {
    for (const k of keys) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  }
}

function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk) => { buf += String(chunk); return true; };
  try { const value = fn(); return { value, stderr: buf }; }
  finally { process.stderr.write = orig; }
}

function writeFixtureKey(name) {
  const dir = join('.harness', 'tmp');
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, TEST_SSH_PRIVATE_KEY, 'utf8');
  chmodSync(path, 0o600);
  return path;
}

function writeRuntimeTemplate(name) {
  const dir = join('.harness', 'tmp');
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, [
    'SAMPLE_API_IMAGE_REPOSITORY=',
    'SAMPLE_WEB_IMAGE_REPOSITORY=',
    'SAMPLE_IMAGE_TAG=',
    'TEST_PUBLIC_BASE_URL=',
    'TEST_API_BASE_URL=',
    'OAUTH_CALLBACK_URL=',
    'POSTGRES_USER=app',
    'POSTGRES_DB=app',
    'MINIO_BUCKET=app',
    'DATABASE_URL=',
    'THIRD_PARTY_CONFIG_KEY=',
    'OPTIONAL_AUTH_ALLOWED_ENVS=test,production',
    'OPTIONAL_AUTH_USERNAME=',
    'OPTIONAL_AUTH_PASSWORD=',
    'OPTIONAL_AUTH_USER_ID=usr_test_user',
    'OPTIONAL_AUTH_DISPLAY_NAME=Test User',
    'OPTIONAL_AUTH_ROLE=admin',
    '',
  ].join('\n'), 'utf8');
  return path;
}

test('resolveRegistryMode: 无 env → 默认 artifact (T-04 R1)', () => {
  withEnv({ HARNESS_DELIVERY_MODE: undefined, HARNESS_REGISTRY_MODE: undefined }, () => {
    assert.equal(resolveRegistryMode(null), 'artifact');
  });
});

test('resolveRegistryMode: HARNESS_DELIVERY_MODE 优先于 entry.registry_mode', () => {
  withEnv({ HARNESS_DELIVERY_MODE: 'registry', HARNESS_REGISTRY_MODE: undefined }, () => {
    assert.equal(resolveRegistryMode({ registry_mode: 'artifact' }), 'registry');
  });
});

test('resolveRegistryMode: HARNESS_REGISTRY_MODE 已不再被运行时识别（Sprint 13 T-07 移除）', () => {
  // 设置旧名但不设新名，应回落到默认 'artifact'（即旧名被忽略）
  withEnv({ HARNESS_DELIVERY_MODE: undefined, HARNESS_REGISTRY_MODE: 'registry' }, () => {
    assert.equal(resolveRegistryMode(null), 'artifact');
  });
});

test('resolveRegistryMode: entry.registry_mode（yml 旧 key）仍兼容并 warn', () => {
  withEnv({ HARNESS_DELIVERY_MODE: undefined, HARNESS_REGISTRY_MODE: undefined }, () => {
    const { value, stderr } = captureStderr(() => resolveRegistryMode({ registry_mode: 'registry' }));
    assert.equal(value, 'registry');
    assert.match(stderr, /deprecated/);
  });
});

test('buildRuntimeMap: 不内置项目专属 runtime 默认值', () => {
  withEnv({}, () => {
    const runtimeMap = buildRuntimeMap('test', 'test-tag');

    assert.equal(runtimeMap.THIRD_PARTY_CONFIG_KEY, undefined);
    assert.equal(runtimeMap.OPTIONAL_AUTH_USERNAME, undefined);
  });
});

test('renderRuntimeFile: 通过模板键自动映射 test 前缀业务变量', () => {
  withEnv({
    TEST_THIRD_PARTY_CONFIG_KEY: 'config-key-for-test',
  }, () => {
    const templatePath = writeRuntimeTemplate('runtime-extra.env.example');
    const { rendered } = renderRuntimeFile('test', templatePath, 'test-tag');
    rmSync(templatePath, { force: true });
    assert.match(rendered, /^THIRD_PARTY_CONFIG_KEY=config-key-for-test$/m);
  });
});

test('renderRuntimeFile: test 前缀业务 secret 通过模板键映射到运行时变量', () => {
  withEnv({
    TEST_DATABASE_URL: 'postgresql://app:secret@db:5432/app',
    TEST_API_BASE_URL: 'https://test.example.com',
    TEST_PUBLIC_BASE_URL: 'https://test.example.com',
    TEST_OPTIONAL_AUTH_USERNAME: 'test-admin',
    TEST_OPTIONAL_AUTH_PASSWORD: 'change-me',
    TEST_OPTIONAL_AUTH_USER_ID: 'usr_test_user',
    TEST_OPTIONAL_AUTH_DISPLAY_NAME: 'Test User',
    TEST_OPTIONAL_AUTH_ROLE: 'admin',
  }, () => {
    const templatePath = writeRuntimeTemplate('runtime-business-secret.env.example');
    const { rendered } = renderRuntimeFile('test', templatePath, 'test-tag');
    rmSync(templatePath, { force: true });
    assert.match(rendered, /^OPTIONAL_AUTH_USERNAME=test-admin$/m);
    assert.match(rendered, /^OPTIONAL_AUTH_PASSWORD=change-me$/m);
    assert.match(rendered, /^OPTIONAL_AUTH_USER_ID=usr_test_user$/m);
    assert.match(rendered, /^OPTIONAL_AUTH_DISPLAY_NAME="Test User"$/m);
    assert.match(rendered, /^OPTIONAL_AUTH_ROLE=admin$/m);
  });
});

test('renderRuntimeFile: 项目前缀镜像变量使用 HARNESS_IMAGE_REPO 和 tag 通用规则', () => {
  withEnv({
    HARNESS_IMAGE_REPO: 'registry.example.com/example-app',
  }, () => {
    const templatePath = writeRuntimeTemplate('runtime-image.env.example');
    const { rendered } = renderRuntimeFile('test', templatePath, 'test-tag');
    rmSync(templatePath, { force: true });
    assert.match(rendered, /^SAMPLE_API_IMAGE_REPOSITORY=registry.example.com\/example-app-api$/m);
    assert.match(rendered, /^SAMPLE_WEB_IMAGE_REPOSITORY=registry.example.com\/example-app-web$/m);
    assert.match(rendered, /^SAMPLE_IMAGE_TAG=test-tag$/m);
  });
});

test('renderRuntimeFile: 模板默认值保留，业务凭据由环境覆盖', () => {
  withEnv({
    TEST_DATABASE_URL: 'postgresql://app:secret@db:5432/app',
    TEST_API_BASE_URL: 'https://test.example.com',
    TEST_PUBLIC_BASE_URL: 'https://test.example.com',
    TEST_OPTIONAL_AUTH_USERNAME: 'test-admin',
    TEST_OPTIONAL_AUTH_PASSWORD: 'change-me',
  }, () => {
    const templatePath = writeRuntimeTemplate('runtime-compat.env.example');
    const { rendered } = renderRuntimeFile('test', templatePath, 'test-tag');
    rmSync(templatePath, { force: true });
    assert.match(rendered, /^OPTIONAL_AUTH_ALLOWED_ENVS=test,production$/m);
    assert.match(rendered, /^OPTIONAL_AUTH_USERNAME=test-admin$/m);
    assert.match(rendered, /^OPTIONAL_AUTH_PASSWORD=change-me$/m);
    assert.match(rendered, /^POSTGRES_USER=app$/m);
    assert.match(rendered, /^POSTGRES_DB=app$/m);
    assert.match(rendered, /^MINIO_BUCKET=app$/m);
  });
});

test('resolveSshKeyInput: HARNESS_SSH_KEY_PATH 优先于 TEST_SSH_PRIVATE_KEY', () => {
  const keyPath = writeFixtureKey('deploy-helpers-harness.key');
  try {
    withEnv({
      HARNESS_SSH_KEY_PATH: keyPath,
      TEST_SSH_PRIVATE_KEY: 'invalid-inline-value',
    }, () => {
      const resolved = resolveSshKeyInput('test');
      assert.equal(resolved.kind, 'path');
      assert.equal(resolved.value, keyPath);
      assert.equal(resolved.source, 'HARNESS_SSH_KEY_PATH');
    });
  } finally {
    rmSync(keyPath, { force: true });
  }
});

test('createSshContext: TEST_SSH_PRIVATE_KEY 支持 GitLab file secret path', () => {
  const keyPath = writeFixtureKey('deploy-helpers-env-path.key');
  try {
    withEnv({
      HARNESS_SSH_KEY_PATH: undefined,
      TEST_SSH_PRIVATE_KEY: keyPath,
    }, () => {
      const context = createSshContext('test', false);
      try {
        const keyIndex = context.sshOptions.indexOf('-i');
        assert.notEqual(keyIndex, -1);
        assert.equal(context.sshOptions[keyIndex + 1], keyPath);
        assert.equal(existsSync(keyPath), true);
      } finally {
        context.cleanup();
      }
    });
  } finally {
    rmSync(keyPath, { force: true });
  }
});

test('createSshContext: TEST_SSH_PRIVATE_KEY 支持原始私钥内容', () => {
  withEnv({
    HARNESS_SSH_KEY_PATH: undefined,
    TEST_SSH_PRIVATE_KEY: TEST_SSH_PRIVATE_KEY,
  }, () => {
    const context = createSshContext('test', false);
    const keyIndex = context.sshOptions.indexOf('-i');
    const generatedPath = context.sshOptions[keyIndex + 1];
    assert.equal(existsSync(generatedPath), true);
    context.cleanup();
    assert.equal(existsSync(generatedPath), false);
  });
});
