import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  ensureSecretsFile,
  expectedSecretsSource,
  loadSecretsFileSnapshot,
} from './lib/secrets-file.mjs';

test('ensureSecretsFile: 缺失时生成模板并写入 required secrets', () => {
  const path = expectedSecretsSource('test');
  rmSync(path, { force: true });
  const result = ensureSecretsFile('test', ['TEST_DEPLOY_USER', 'TEST_API_BASE_URL']);
  assert.equal(result.created, true);
  assert.equal(existsSync(path), true);
  const content = readFileSync(path, 'utf8');
  assert.match(content, /export TEST_DEPLOY_USER=''/);
  assert.match(content, /export TEST_API_BASE_URL=''/);
  rmSync(path, { force: true });
});

test('loadSecretsFileSnapshot: 从 .harness\\/secrets\\/test.sh 读取 export 值', () => {
  const path = expectedSecretsSource('test');
  ensureSecretsFile('test', ['TEST_DEPLOY_USER']);
  writeFileSync(path, [
    '#!/usr/bin/env bash',
    "export TEST_DEPLOY_USER='deployer'",
    "export TEST_API_BASE_URL='https://test.example.com'",
    '',
  ].join('\n'));
  const snapshot = loadSecretsFileSnapshot('test', ['TEST_DEPLOY_USER', 'TEST_API_BASE_URL']);
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.values.TEST_DEPLOY_USER, 'deployer');
  assert.equal(snapshot.values.TEST_API_BASE_URL, 'https://test.example.com');
  rmSync(path, { force: true });
});
