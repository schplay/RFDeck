import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT ?? '4180';
// HTTPS, as every install serves it. The certificate is the one the server
// generates for itself, so nothing here can be asked to trust it.
const baseURL = `https://127.0.0.1:${PORT}`;

// End-to-end tests against a real RFDeck: real server, real database, real
// socket, the built UI served the way a deployment serves it.
//
// These exist because the unit suite cannot fail the way this application has
// actually broken. Every defect found in live use — a mute posting to a path
// the firmware does not serve, a Listen that switched itself off, a page blank
// after waking, a phone layout that scrolled sideways — compiled cleanly and
// passed every unit test. They were failures of the whole, and only clicking
// found them.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },

  // Serial on purpose. One server and one database are shared, and going live
  // is global state: parallel workers would fight over it and fail in ways
  // that say nothing about the code.
  fullyParallel: false,
  workers: 1,

  // A flaky end-to-end test is worse than none — it teaches people to ignore
  // red. Retry once locally to absorb genuine timing noise, never in CI, where
  // a retry would hide exactly the intermittency worth knowing about.
  retries: 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      // The phone spec belongs to the mobile project; at a desktop viewport
      // there is no hamburger for it to find.
      testIgnore: /mobile.spec.ts/,
    },
    // The phone is a supported surface, and a layout regression there is
    // invisible from a desktop run.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],

  // A real server on a fresh database, stopped and removed when the run ends,
  // pass or fail. See e2e/globalSetup.mjs for why this isn't `webServer`.
  globalSetup: './e2e/globalSetup.mjs',
});
