// ⚠️ MAI-Harness 框架文件 — 请勿在项目中修改。如需变更请在框架工程中修改并覆盖到此项目。

/**
 * E2E Auth Helper — API 登录 + SPA 状态注入
 *
 * 适用于 Vue 3 + Pinia 的 SPA 项目。
 * 通过 API 登录获取 Token，注入到 Pinia Store，避免 UI 交互开销。
 *
 * 自定义方式：
 * 1. 修改 API_BASE 和登录端点路径
 * 2. 修改 TEST_USER 为项目 E2E 种子数据用户
 * 3. 修改 loginViaAPI 中的 Pinia Store 结构以匹配项目 Auth Store
 */
import { type Page } from '@playwright/test'

// TODO: 修改为项目后端地址
const API_BASE = 'http://localhost:3000'

// TODO: 修改为 seed-e2e 脚本创建的测试用户
export const TEST_USER = {
  email: 'e2e@example.dev',
  password: 'password123',
}

/**
 * Login via API and inject auth state into the SPA.
 * Avoids UI interaction for faster setup in non-auth tests.
 */
export async function loginViaAPI(page: Page) {
  // TODO: 修改为项目登录 API 端点
  const res = await page.request.post(`${API_BASE}/api/v1/auth/login`, {
    data: { email: TEST_USER.email, password: TEST_USER.password },
  })
  const body = await res.json()

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // TODO: 修改 Pinia Store 结构以匹配项目 Auth Store
  await page.evaluate((token: string) => {
    const app = (document.querySelector('#app') as any)?.__vue_app__
    const pinia = app?.config?.globalProperties?.$pinia
    if (pinia) {
      pinia.state.value.auth = {
        user: { email: 'e2e@example.dev' },
        accessToken: token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      }
    }
  }, body.accessToken)
}

/**
 * Navigate within SPA using Vue Router (preserves Pinia state).
 */
export async function navigateSPA(page: Page, path: string) {
  await page.evaluate((p: string) => {
    const app = (document.querySelector('#app') as any)?.__vue_app__
    const router = app?.config?.globalProperties?.$router
    router?.push(p)
  }, path)
  await page.waitForLoadState('networkidle')
}
