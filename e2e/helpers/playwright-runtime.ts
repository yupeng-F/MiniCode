/* eslint-disable harness/no-magic-values -- Shared Playwright runtime defaults centralize the fallback ports. */
const DEFAULT_API_PORT = 3000
const DEFAULT_WEB_PORT = 5173
/* eslint-enable harness/no-magic-values */

export interface PlaywrightRuntime {
  apiPort: number
  webPort: number
  apiBaseUrl: string
  webBaseUrl: string
  reuseExistingServer: boolean
}

const API_BASE_URL_ENV_NAMES = [
  'E2E_API_URL',
  'TEST_API_BASE_URL',
  'PLAYWRIGHT_API_BASE_URL',
] as const

const WEB_BASE_URL_ENV_NAMES = [
  'E2E_BASE_URL',
  'TEST_PUBLIC_BASE_URL',
  'TEST_API_BASE_URL',
  'PLAYWRIGHT_WEB_BASE_URL',
] as const

function readPort(name: 'PLAYWRIGHT_API_PORT' | 'PLAYWRIGHT_WEB_PORT', fallback: number): number {
  const value = process.env[name]
  if (!value) {
    return fallback
  }

  const port = Number.parseInt(value, 10)
  return Number.isInteger(port) && port > 0 ? port : fallback
}

function readReuseExistingServer(): boolean {
  return process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true'
}

function readFirstDefinedEnvValue(names: readonly string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) {
      return value
    }
  }

  return null
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/u, '')
}

function normalizeApiBaseUrl(raw: string): string {
  let url = normalizeBaseUrl(raw)
  if (url.endsWith('/api')) {
    url = url.slice(0, -4)
  }

  return url
}

function readApiBaseUrl(apiPort: number): string {
  const value = readFirstDefinedEnvValue(API_BASE_URL_ENV_NAMES)
  return value ? normalizeApiBaseUrl(value) : `http://127.0.0.1:${apiPort}`
}

function readWebBaseUrl(webPort: number): string {
  const value = readFirstDefinedEnvValue(WEB_BASE_URL_ENV_NAMES)
  return value ? normalizeBaseUrl(value) : `http://127.0.0.1:${webPort}`
}

export function getPlaywrightRuntime(): PlaywrightRuntime {
  const apiPort = readPort('PLAYWRIGHT_API_PORT', DEFAULT_API_PORT)
  const webPort = readPort('PLAYWRIGHT_WEB_PORT', DEFAULT_WEB_PORT)

  return {
    apiPort,
    webPort,
    apiBaseUrl: readApiBaseUrl(apiPort),
    webBaseUrl: readWebBaseUrl(webPort),
    reuseExistingServer: readReuseExistingServer(),
  }
}
