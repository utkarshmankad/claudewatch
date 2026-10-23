import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

// Loads the real popup from claudewatch-extension/ with a stubbed chrome.* API, so the Autopilot
// card is exercised end to end in a browser: states, accessible text, events and storage.

const ROOT = join(process.cwd(), 'claudewatch-extension');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const H = 3_600_000;

interface Stats { providerUsage: Record<string, unknown>; providerHealth: Record<string, unknown> }
const snap = (pct5h: number, extra: Record<string, unknown> = {}) => ({ ts: Date.now() - 60_000, accountId: 'a', pct5h, pct7d: 10, resetsAt5h: Date.now() + 3 * H, resetsAt7d: Date.now() + 72 * H, ...extra });
const fresh = { ok: true, stale: false, hasData: true };

async function openPage(page: Page, path: string, stats: Stats | null, stored: Record<string, unknown> = {}) {
  await page.route('http://ext.test/**', async (route) => {
    const path = normalize(new URL(route.request().url()).pathname).replace(/^\/+/, '');
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'text/plain', body: readFileSync(file) });
  });
  await page.addInitScript(({ statsArg, storedArg }) => {
    const w = window as unknown as Record<string, any>;
    w.__events = []; w.__tabs = [];
    const area = (init: Record<string, unknown>) => {
      const data: Record<string, unknown> = { ...init };
      return {
        get: (key: unknown, cb: (v: unknown) => void) => {
          if (typeof key === 'string') return cb(key in data ? { [key]: data[key] } : {});
          const defaults = (key ?? {}) as Record<string, unknown>; // object form: defaults merged with stored values
          return cb(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, k in data ? data[k] : v])));
        },
        set: (obj: Record<string, unknown>, cb?: () => void) => { Object.assign(data, obj); cb?.(); },
      };
    };
    w.chrome = {
      runtime: {
        lastError: undefined, getManifest: () => ({ version: '0.14.3' }), openOptionsPage() {},
        sendMessage(msg: any, cb?: (r: unknown) => void) {
          if (msg.type === 'GET_STATS') cb?.(statsArg);
          else if (msg.type === 'ANALYTICS_AUTOPILOT') { w.__events.push({ name: msg.name, props: msg.props }); cb?.({ ok: true }); }
          else cb?.({ enabled: false, counts24h: {} });
        },
      },
      storage: { sync: area((storedArg.sync ?? {}) as Record<string, unknown>), local: area((storedArg.local ?? {}) as Record<string, unknown>) },
      tabs: { create: (o: unknown) => w.__tabs.push(o) },
    };
    window.close = () => {};
  }, { statsArg: stats, storedArg: { sync: stored.sync, local: stored.local } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://ext.test/${path}`);
  return errors;
}

const openPopup = (page: Page, stats: Stats | null, stored: Record<string, unknown> = {}) => openPage(page, 'popup/popup.html', stats, stored);
const card = (page: Page) => page.getByRole('region', { name: 'Autopilot recommendation' });
const events = (page: Page) => page.evaluate(() => (window as any).__events as Array<{ name: string; props: Record<string, string> }>);

test('ready: one primary recommendation with benefit, confidence, reset context and Open provider', async ({ page }) => {
  const errors = await openPopup(page, { providerUsage: { claude: snap(10), chatgpt: snap(40) }, providerHealth: { claude: fresh, chatgpt: fresh } });
  await expect(card(page).getByText('Use Claude next')).toBeVisible();
  await expect(card(page).getByText(/About 90% of quota left/)).toBeVisible();
  await expect(card(page).getByText(/Confidence: (low|medium|high)/)).toBeVisible();
  await expect(card(page).getByText(/^Resets /)).toBeVisible();
  await expect(card(page).getByText('Also available: ChatGPT')).toBeVisible();
  await expect(card(page)).toHaveAttribute('aria-busy', 'false');
  await expect(card(page).locator('#ap-body')).toHaveAttribute('aria-live', 'polite');

  await card(page).getByText('Why this?').click();
  await expect(card(page).getByText('This compares remaining quota and risk, not model quality.')).toBeVisible();
  await card(page).getByRole('button', { name: 'Open Claude', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__tabs)).toEqual([{ url: 'https://claude.ai' }]);

  const names = (await events(page)).map((e) => e.name);
  expect(names).toEqual(expect.arrayContaining(['recommendation_impression', 'explanation_viewed', 'provider_opened']));
  expect(await events(page)).toContainEqual({ name: 'recommendation_impression', props: { action: 'use', provider: 'claude', confidence: 'low', state: 'ready' } });
  expect(JSON.stringify(await events(page))).not.toMatch(/@|https?:|accountId/);
  expect(errors).toEqual([]);
});

test('insufficient data: explains how to get a recommendation and records no impression', async ({ page }) => {
  await openPopup(page, { providerUsage: {}, providerHealth: {} });
  await expect(card(page).getByText(/Not enough data yet/)).toBeVisible();
  expect((await events(page)).filter((e) => e.name === 'recommendation_impression')).toEqual([]);
});

test('stale: warns that the recommendation is a guess', async ({ page }) => {
  await openPopup(page, { providerUsage: { claude: snap(10) }, providerHealth: { claude: { ...fresh, stale: true } } });
  await expect(card(page).getByText(/out of date, so treat this as a guess/)).toBeVisible();
  await expect(card(page).getByText('Confidence: low')).toBeVisible();
});

test('all providers limited: shows the earliest reset and lets the user choose to wait', async ({ page }) => {
  await openPopup(page, {
    providerUsage: { claude: snap(100, { resetsAt5h: Date.now() + 2 * H }), chatgpt: snap(100, { resetsAt5h: Date.now() + H }) },
    providerHealth: { claude: fresh, chatgpt: fresh },
  });
  await expect(card(page).getByText('Every available provider is at its limit.')).toBeVisible();
  await expect(card(page).getByText(/^ChatGPT resets first, at /)).toBeVisible();
  await card(page).getByRole('button', { name: "I'll wait" }).click();
  await expect(card(page).getByText(/Autopilot updates when a provider resets/)).toBeVisible();
  expect(await events(page)).toContainEqual({ name: 'wait_chosen', props: { provider: 'chatgpt' } });
});

test('disabled: shows an off state with a Turn on control; preferences exclude providers', async ({ page }) => {
  await openPopup(page, { providerUsage: { claude: snap(10) }, providerHealth: { claude: fresh } }, { sync: { autopilotPrefs: { disabled: true } } });
  await expect(card(page).getByText('Autopilot recommendations are off.')).toBeVisible();
  await card(page).getByRole('button', { name: 'Turn on' }).click();
  await expect(card(page).getByText('Use Claude next')).toBeVisible();
  expect(await events(page)).toContainEqual({ name: 'autopilot_toggled', props: { enabled: true } });
});

test('dismiss hides the card until the recommendation changes', async ({ page }) => {
  await openPopup(page, { providerUsage: { claude: snap(10) }, providerHealth: { claude: fresh } });
  await card(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(card(page).getByText('Recommendation hidden until it changes.')).toBeVisible();
  expect(await events(page)).toContainEqual({ name: 'recommendation_dismissed', props: { action: 'use' } });
});

test('a changed recommendation says what caused it', async ({ page }) => {
  const previous = { at: Date.now() - H, action: 'use', provider: 'claude', confidence: 'medium', prefsKey: JSON.stringify([false, 'general', null, [], 0, null]),
    status: { claude: { auth: true, limited: false, stale: false, used: 40 }, chatgpt: { auth: true, limited: false, stale: false, used: 30 }, gemini: { auth: false, limited: false, stale: false, used: null } } };
  await openPopup(page, { providerUsage: { claude: snap(100), chatgpt: snap(30) }, providerHealth: { claude: fresh, chatgpt: fresh } }, { local: { autopilot_last: previous } });
  await expect(card(page).getByText('Use ChatGPT next')).toBeVisible();
  await expect(card(page).getByText('Changed from Claude: Claude reached its limit')).toBeVisible();
});

test('settings: controls save immediately, record which setting changed (not its value) and drive the popup', async ({ page }) => {
  const errors = await openPage(page, 'settings/settings.html', null);
  const panel = page.getByRole('region', { name: 'Autopilot' });
  await expect(panel.getByLabel('Task type')).toBeVisible();
  await panel.getByLabel('Task type').selectOption('coding');
  await panel.getByLabel('Reserved quota (%)').fill('20');
  await panel.getByLabel('Reserved quota (%)').dispatchEvent('change');
  await panel.getByLabel('Notification frequency').selectOption('all');
  await panel.getByLabel('Prefer this provider when it is usable').selectOption('chatgpt');
  await panel.getByLabel('ChatGPT', { exact: true }).check();   // exclusion wins over preference
  await expect(panel.getByLabel('Prefer this provider when it is usable')).toHaveValue('');
  await panel.getByText('Use working hours', { exact: true }).click(); // the switch input is visually hidden: click its label
  await expect(panel.getByLabel('Start hour')).toBeEnabled();
  await expect(panel.getByText('Saved ✓')).toBeVisible();
  const names = (await events(page)).map((e) => e.props.setting);
  expect(names).toEqual(expect.arrayContaining(['task', 'reserved', 'notification_frequency', 'pinned', 'excluded', 'working_hours']));
  expect(JSON.stringify(await events(page))).not.toMatch(/coding|chatgpt|20/);
  await panel.getByText('Show Autopilot recommendations', { exact: true }).click();
  expect(await events(page)).toContainEqual({ name: 'autopilot_toggled', props: { enabled: false } });
  expect(errors.filter((e) => !/analytics|activity/i.test(e))).toEqual([]);
});
