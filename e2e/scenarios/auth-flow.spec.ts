// ⚠️ MAI-Harness 框架文件 — 请勿在项目中修改。如需变更请在框架工程中修改并覆盖到此项目。

/**
 * E2E Scenarios: Authentication Flows（示例）
 *
 * Harness G-5: 用户可见的业务链路须有对应的 Playwright Test 用例。
 *
 * 本文件为认证场景示例模板，包含：
 * - 正确登录 → 跳转
 * - 错误密码 → 错误提示（无循环请求）
 * - 未认证访问 → 重定向到登录
 *
 * 自定义方式：
 * 1. 修改选择器以匹配项目的登录页 UI
 * 2. 根据 User Story 添加更多认证场景
 * 3. 为每个关键业务链路创建独立的 spec 文件
 */
import { test, expect } from '@playwright/test'
import { TEST_USER } from '../helpers/auth'

test.describe('Authentication', () => {
  test('login with correct credentials → redirect to dashboard', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    // TODO: 修改选择器以匹配项目登录表单
    await page.fill('input[type="email"]', TEST_USER.email)
    await page.fill('input[type="password"]', TEST_USER.password)
    await page.click('button[type="submit"]')

    // TODO: 修改跳转目标路由
    await page.waitForURL('**/dashboard**', { timeout: 10_000 })
    await expect(page).toHaveURL(/dashboard/)
  })

  test('login with wrong password → show error, no infinite loop', async ({ page }) => {
    const apiCalls: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/')) apiCalls.push(req.url())
    })

    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    await page.fill('input[type="email"]', TEST_USER.email)
    await page.fill('input[type="password"]', 'wrongpassword')

    apiCalls.length = 0
    await page.click('button[type="submit"]')
    await page.waitForTimeout(3000)

    // Should only send ONE login request (no retry/refresh loop)
    const loginCalls = apiCalls.filter((u) => u.includes('/auth/login'))
    expect(loginCalls).toHaveLength(1)

    // Error message should be visible
    // TODO: 修改选择器以匹配项目错误提示
    const errorMessage = page.locator('[role="alert"], .text-red-600, .text-destructive').first()
    await expect(errorMessage).toBeVisible()
  })

  test('unauthenticated access → redirect to login', async ({ page }) => {
    // TODO: 修改为项目需要认证的页面路径
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    await expect(page).toHaveURL(/login/)
  })
})
