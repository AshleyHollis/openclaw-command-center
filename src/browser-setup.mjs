import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const PLAYWRIGHT_VERSION = '1.62.1';
const installedPlaywrightVersion = require('playwright/package.json').version;
export async function launchPinnedChromium({
  version = installedPlaywrightVersion,
  environment = process.env,
  browserType
} = {}) {
  if (version !== PLAYWRIGHT_VERSION) throw new Error(`Topic Page browser setup requires Playwright ${PLAYWRIGHT_VERSION}; found ${version}.`);
  if (typeof environment.PLAYWRIGHT_BROWSERS_PATH !== 'string' || environment.PLAYWRIGHT_BROWSERS_PATH.trim() === '') {
    throw new Error('Topic Page browser setup requires the evaluator-provided PLAYWRIGHT_BROWSERS_PATH.');
  }
  const chromium = browserType ?? (await import('playwright')).chromium;
  return chromium.launch({ headless: true });
}
