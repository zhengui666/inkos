import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = process.env.PI_SCRATCH_DIR ?? tmpdir();
const project = process.env.INKOS_E2E_ROOT ?? mkdtempSync(join(scratch, 'inkos-studio-e2e-'));
process.env.INKOS_E2E_ROOT = project;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  outputDir: join(project, 'browser-results'),
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4580', locale: 'en-US', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure', launchOptions: process.env.INKOS_BROWSER_EXECUTABLE ? { executablePath: process.env.INKOS_BROWSER_EXECUTABLE } : {} },
  webServer: {
    command: 'npm run build:client && tsx e2e/serve.ts',
    url: 'http://127.0.0.1:4580/api/v1/status',
    env: { INKOS_E2E_ROOT: project, INKOS_STUDIO_PORT: '4580' },
    reuseExistingServer: false,
    timeout: 60_000,
    cwd: '.',
  },
});
