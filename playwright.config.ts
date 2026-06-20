import { defineConfig } from '@playwright/test';

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  reporter: isCI ? 'dot' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:1420',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    channel: 'msedge',
  },
  webServer: {
    command: 'corepack pnpm dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
