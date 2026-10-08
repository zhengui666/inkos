import { defineConfig } from '@playwright/test';

// Vite serves only the UI. The spec intercepts all API requests, so no runner,
// model, account or publisher is started by these disposable fixture tests.
export default defineConfig({
  testDir: './e2e', testMatch: 'creation-task-board.spec.ts', timeout: 30_000, workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4592', headless: true, screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4592 --strictPort',
    url: 'http://127.0.0.1:4592', reuseExistingServer: false, cwd: '.',
  },
});
