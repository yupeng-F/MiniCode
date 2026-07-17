import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import {
  buildFallbackCaseGrepPattern,
  buildServiceHealthCommand,
  buildPlaywrightCommand,
  formatCurrentCaseResult,
  isLiveGatePassed,
  qualityReportBasename,
  shouldRunP0Regression,
  splitCasesByRunner,
  summarizePlaywrightCaseRun,
} from './quality-score.mjs';

test('splitCasesByRunner: src/** standard 用例不进入 Step 5 E2E 候选', () => {
  const cases = [
    { id: 'TC-E2E', spec: 'e2e/scenarios/sprint-17/foo.spec.ts', execution: { mode: 'standard' } },
    { id: 'TC-UNIT', spec: 'src/modules/foo/__tests__/foo.test.ts', execution: { mode: 'standard' } },
  ];

  const { e2eCases, standardCases } = splitCasesByRunner(cases);

  assert.deepEqual(e2eCases.map(testCase => testCase.id), ['TC-E2E']);
  assert.deepEqual(standardCases.map(testCase => testCase.id), ['TC-UNIT']);
});

test('summarizePlaywrightCaseRun: skipped + reason 被识别为 skipped 而非 fail/pass', () => {
  const runResult = {
    ok: true,
    stdout: `${JSON.stringify({
      stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 1 },
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  annotations: [
                    { type: 'skip', description: 'Missing live prerequisites: PLAYWRIGHT_ADMIN_TOKEN' },
                  ],
                  results: [{ status: 'skipped' }],
                },
              ],
            },
          ],
        },
      ],
    })}\n`,
  };

  assert.deepEqual(summarizePlaywrightCaseRun(runResult), {
    status: 'skipped',
    reason: 'Missing live prerequisites: PLAYWRIGHT_ADMIN_TOKEN',
  });
});

test('isLiveGatePassed: live gate 仅允许 passed 通过，skipped 不能放行', () => {
  assert.equal(isLiveGatePassed({ status: 'passed', reason: '' }), true);
  assert.equal(isLiveGatePassed({ status: 'skipped', reason: 'Missing live prerequisites: PLAYWRIGHT_ADMIN_TOKEN' }), false);
  assert.equal(isLiveGatePassed({ status: 'failed', reason: '' }), false);
});

test('formatCurrentCaseResult: live skipped(reason) 仍保留 reason 展示', () => {
  assert.equal(
    formatCurrentCaseResult(
      { execution: { mode: 'live' } },
      { status: 'skipped', reason: 'Missing live prerequisites: PLAYWRIGHT_ADMIN_TOKEN' },
    ),
    '⚠️ skipped（Missing live prerequisites: PLAYWRIGHT_ADMIN_TOKEN）（真实链路）',
  );
});

test('shouldRunP0Regression: L1/L2/L3 均执行历史 P0 回归', () => {
  assert.equal(shouldRunP0Regression('L1'), true);
  assert.equal(shouldRunP0Regression('L2'), true);
  assert.equal(shouldRunP0Regression('L3'), true);
});

test('qualityReportBasename: sprint id 只补一次 sprint- 前缀', () => {
  assert.equal(qualityReportBasename('5-demo'), 'sprint-5-demo-quality');
  assert.equal(qualityReportBasename('sprint-5-demo'), 'sprint-5-demo-quality');
});

test('buildPlaywrightCommand: Step 5 Playwright 复用已有 server', () => {
  const command = buildPlaywrightCommand({
    specs: ['e2e/scenarios/sprint-17/foo.spec.ts'],
    grepPattern: 'TC-S17-LS-01',
    env: { FOO: 'bar' },
    reporter: 'json',
  });

  assert.match(command, /^FOO='bar' PLAYWRIGHT_REUSE_EXISTING_SERVER='true' pnpm test:e2e /);
  assert.match(command, /--grep 'TC-S17-LS-01'/);
  assert.match(command, /--reporter=json 2>\/dev\/null$/);
});

test('buildPlaywrightCommand: TEST_* 存在时自动映射到 E2E test runtime', () => {
  const originalEnv = {
    TEST_API_BASE_URL: process.env.TEST_API_BASE_URL,
    TEST_PUBLIC_BASE_URL: process.env.TEST_PUBLIC_BASE_URL,
    E2E_MODE: process.env.E2E_MODE,
    E2E_BASE_URL: process.env.E2E_BASE_URL,
    E2E_API_URL: process.env.E2E_API_URL,
    E2E_AUTH_MODE: process.env.E2E_AUTH_MODE,
    E2E_CONFIG_ENV: process.env.E2E_CONFIG_ENV,
  };

  Object.assign(process.env, {
    TEST_API_BASE_URL: 'https://test-api.example.com/api',
    TEST_PUBLIC_BASE_URL: 'https://test-web.example.com',
  });
  delete process.env.E2E_MODE;
  delete process.env.E2E_BASE_URL;
  delete process.env.E2E_API_URL;
  delete process.env.E2E_AUTH_MODE;
  process.env.E2E_CONFIG_ENV = 'unit-no-config';

  try {
    const command = buildPlaywrightCommand({
      specs: ['e2e/scenarios/foo.spec.ts'],
    });

    assert.match(command, /^E2E_MODE='test' E2E_BASE_URL='https:\/\/test-web\.example\.com' E2E_API_URL='https:\/\/test-api\.example\.com\/api' E2E_USE_WEBSERVER='0' PLAYWRIGHT_REUSE_EXISTING_SERVER='true' pnpm test:e2e /);
    assert.doesNotMatch(command, /PASSWORD_LOGIN/);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('buildPlaywrightCommand: 显式 E2E_AUTH_MODE 透传，框架不推断项目认证策略', () => {
  const originalEnv = {
    TEST_API_BASE_URL: process.env.TEST_API_BASE_URL,
    TEST_PUBLIC_BASE_URL: process.env.TEST_PUBLIC_BASE_URL,
    E2E_AUTH_MODE: process.env.E2E_AUTH_MODE,
  };

  Object.assign(process.env, {
    TEST_API_BASE_URL: 'https://test-api.example.com/api',
    TEST_PUBLIC_BASE_URL: 'https://test-web.example.com',
    E2E_AUTH_MODE: 'custom-auth',
  });

  try {
    const command = buildPlaywrightCommand({
      specs: ['e2e/scenarios/foo.spec.ts'],
    });

    assert.match(command, /E2E_AUTH_MODE='custom-auth'/);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('buildPlaywrightCommand: E2E auth 策略可由项目 environments.yml 声明', () => {
  const configPath = '.harness/tmp/quality-score-e2e-config.yml';
  mkdirSync('.harness/tmp', { recursive: true });
  writeFileSync(configPath, [
    'version: 1',
    'promote_strategy: manual',
    'environments:',
    '  test:',
    '    e2e:',
    '      auth_mode: custom-auth',
    '',
  ].join('\n'), 'utf8');

  const originalEnv = {
    TEST_API_BASE_URL: process.env.TEST_API_BASE_URL,
    TEST_PUBLIC_BASE_URL: process.env.TEST_PUBLIC_BASE_URL,
    E2E_AUTH_MODE: process.env.E2E_AUTH_MODE,
    E2E_CONFIG_PATH: process.env.E2E_CONFIG_PATH,
    E2E_CONFIG_ENV: process.env.E2E_CONFIG_ENV,
  };

  Object.assign(process.env, {
    TEST_API_BASE_URL: 'https://test-api.example.com/api',
    TEST_PUBLIC_BASE_URL: 'https://test-web.example.com',
    E2E_CONFIG_PATH: configPath,
    E2E_CONFIG_ENV: 'test',
  });
  delete process.env.E2E_AUTH_MODE;

  try {
    const command = buildPlaywrightCommand({
      specs: ['e2e/scenarios/foo.spec.ts'],
    });

    assert.match(command, /E2E_AUTH_MODE='custom-auth'/);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(configPath, { force: true });
  }
});

test('buildPlaywrightCommand: 显式 E2E_MODE 优先于 TEST_* 自动模式', () => {
  const originalEnv = {
    TEST_API_BASE_URL: process.env.TEST_API_BASE_URL,
    TEST_PUBLIC_BASE_URL: process.env.TEST_PUBLIC_BASE_URL,
    E2E_MODE: process.env.E2E_MODE,
    E2E_BASE_URL: process.env.E2E_BASE_URL,
    E2E_API_URL: process.env.E2E_API_URL,
  };

  Object.assign(process.env, {
    TEST_API_BASE_URL: 'https://test-api.example.com/api',
    TEST_PUBLIC_BASE_URL: 'https://test-web.example.com',
    E2E_MODE: 'remote-custom',
  });
  delete process.env.E2E_BASE_URL;
  delete process.env.E2E_API_URL;

  try {
    const command = buildPlaywrightCommand({
      specs: ['e2e/scenarios/foo.spec.ts'],
    });

    assert.match(command, /^E2E_MODE='remote-custom' /);
    assert.doesNotMatch(command, /^E2E_MODE='test' /);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('buildFallbackCaseGrepPattern: fallback 只使用结构化 TC ID，不硬编码业务标题', () => {
  assert.equal(
    buildFallbackCaseGrepPattern({ id: 'TC-S17-LS-05', tags: ['image'] }),
    'TC-S17-LS-05',
  );
});

test('buildServiceHealthCommand: test 环境优先使用远端 health/ready', () => {
  const command = buildServiceHealthCommand({
    TEST_API_BASE_URL: 'https://aish-test.wshoto.com/api/',
  }, '/repo');

  assert.deepEqual(command, {
    command: "curl -fsS --max-time 10 'https://aish-test.wshoto.com/health' >/dev/null && curl -fsS --max-time 10 'https://aish-test.wshoto.com/ready' >/dev/null",
    detail: '✅ 通过（remote health endpoints）',
    mode: 'remote',
  });
});
