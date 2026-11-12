import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/frontend',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8796', viewport: { width: 1440, height: 960 }, trace: 'retain-on-failure' },
  webServer: { command: 'node test/frontend/static-server.mjs', url: 'http://127.0.0.1:8796', reuseExistingServer: false },
});
