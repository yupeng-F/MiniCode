// scripts/required-secrets.test.mjs — Sprint 12 T-02 / P1-#8
// 覆盖 scripts/lib/required-secrets.mjs:
//   - baseRequiredSecrets: env→prefix 列表生成（test 6 项 / prod 8 项）
//   - resolveRequiredSecrets: extra 合并 / legacy 兼容 / 双字段冲突 fatal
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { baseRequiredSecrets, resolveRequiredSecrets } from './lib/required-secrets.mjs';

test('baseRequiredSecrets(test): 6 项部署 secret', () => {
  const list = baseRequiredSecrets('test');
  assert.equal(list.length, 6);
  assert.ok(list.includes('TEST_DEPLOY_USER'));
  assert.ok(list.includes('TEST_DEPLOY_HOST'));
  assert.ok(list.includes('TEST_DEPLOY_PORT'));
  assert.ok(list.includes('TEST_DEPLOY_WORKDIR'));
  assert.ok(list.includes('TEST_API_BASE_URL'));
  assert.ok(list.includes('TEST_SSH_PRIVATE_KEY'));
  assert.ok(!list.some((s) => /REGISTRY/.test(s)), 'test 不应含 REGISTRY_*');
});

test('baseRequiredSecrets(prod): 8 项（含 REGISTRY_USERNAME/PASSWORD）', () => {
  const list = baseRequiredSecrets('prod');
  assert.equal(list.length, 8);
  assert.ok(list.includes('PROD_REGISTRY_USERNAME'));
  assert.ok(list.includes('PROD_REGISTRY_PASSWORD'));
  assert.ok(list.includes('PROD_DEPLOY_USER'));
});

test('resolveRequiredSecrets: schema v2 (base + extra) 合并去重', () => {
  const entry = {
    extra_required_secrets: ['TEST_WECOM_CORP_ID', 'TEST_AI_API_KEY'],
  };
  const list = resolveRequiredSecrets('test', entry);
  // base 6 + extra 2 = 8
  assert.equal(list.length, 8);
  assert.ok(list.includes('TEST_DEPLOY_USER'));
  assert.ok(list.includes('TEST_WECOM_CORP_ID'));
  assert.ok(list.includes('TEST_AI_API_KEY'));
  // base 在前
  assert.equal(list[0], 'TEST_DEPLOY_USER');
});

test('resolveRequiredSecrets: 无 extra 时返回纯 base', () => {
  const list = resolveRequiredSecrets('test', {});
  assert.equal(list.length, 6);
});

test('resolveRequiredSecrets: extra 与 base 重复项被去重', () => {
  const list = resolveRequiredSecrets('test', {
    extra_required_secrets: ['TEST_DEPLOY_USER', 'TEST_WECOM_CORP_ID'],
  });
  assert.equal(list.length, 7);
  assert.equal(list.filter((s) => s === 'TEST_DEPLOY_USER').length, 1);
});

test('resolveRequiredSecrets: legacy 模式（required_secrets 非空）原样返回 + warn', () => {
  // legacy 字段非空 → 直接返回，不做 base 合并
  const entry = {
    required_secrets: ['TEST_FOO', 'TEST_BAR'],
  };
  const list = resolveRequiredSecrets('test', entry);
  assert.deepEqual(list, ['TEST_FOO', 'TEST_BAR']);
});

test('resolveRequiredSecrets: 双字段冲突 → fatal（子进程退出码 1）', () => {
  const code = `
    import('./scripts/lib/required-secrets.mjs').then(({ resolveRequiredSecrets }) => {
      resolveRequiredSecrets('test', {
        required_secrets: ['A'],
        extra_required_secrets: ['B'],
      });
    });
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf-8',
    cwd: process.cwd(),
  });
  assert.equal(r.status, 1, `预期 exit 1，实际 ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /不可同时声明 required_secrets 与 extra_required_secrets/);
});

test('resolveRequiredSecrets: legacy required_secrets=[] 视为未声明，走 base+extra', () => {
  // 空数组不算 legacy（hasLegacy 要求非空）
  const list = resolveRequiredSecrets('test', { required_secrets: [], extra_required_secrets: ['TEST_X'] });
  assert.equal(list.length, 7);
  assert.ok(list.includes('TEST_X'));
});
