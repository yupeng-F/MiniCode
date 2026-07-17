// ⚠️ MAI-Harness 框架文件 — 请勿在项目中修改。如需变更请在框架工程中修改并覆盖到此项目。

/**
 * Playwright Test Configuration — E2E 场景测试
 *
 * Harness G-5: 关键业务链路须有 e2e/scenarios/ 下对应的 Playwright Test 用例。
 *
 * 自定义方式：
 * 1. 修改 webServer 中的启动命令和端口（适配项目的前后端启动方式）
 * 2. 修改 baseURL 为前端开发服务器地址
 * 3. 按需添加 projects（Firefox、WebKit、Mobile 等）
 */
import { defineConfig, devices } from '@playwright/test'
import { getPlaywrightRuntime } from './e2e/helpers/playwright-runtime'

/* eslint-disable harness/no-magic-values -- centralized Playwright config constants keep fixed test infrastructure values readable */
const PLAYWRIGHT_RETRIES = 1
const TEST_TIMEOUT_MS = 30_000
const EXPECT_TIMEOUT_MS = 5_000
const E2E_REPORT_OUTPUT_DIR = 'coverage/e2e-report'
/* eslint-enable harness/no-magic-values */
const runtime = getPlaywrightRuntime()

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: PLAYWRIGHT_RETRIES,
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  reporter: [['list'], ['html', { open: 'never', outputFolder: E2E_REPORT_OUTPUT_DIR }]],

  use: {
    baseURL: runtime.webBaseUrl,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      testIgnore: /.*-standard\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
      webServer: [
        {
          command: `PORT=${runtime.apiPort} pnpm dev:api`,
          port: runtime.apiPort,
          reuseExistingServer: runtime.reuseExistingServer,
          timeout: TEST_TIMEOUT_MS,
        },
        {
          command: `VITE_API_URL=${runtime.apiBaseUrl} pnpm dev:web -- --port ${runtime.webPort}`,
          port: runtime.webPort,
          reuseExistingServer: runtime.reuseExistingServer,
          timeout: TEST_TIMEOUT_MS,
        },
      ],
    },
    {
      name: 'standard-only',
      testMatch: /.*-standard\.spec\.ts$/,
      use: {},
      fullyParallel: false,
      // 无 webServer 配置 - standard case 不需要启动服务器
    },
  ],
})
