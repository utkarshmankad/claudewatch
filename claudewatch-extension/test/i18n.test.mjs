import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pseudoLocalize, pseudoLocalizeCatalog } from '../lib/pseudo-locale.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const en = JSON.parse(read('_locales/en/messages.json'));
const xa = JSON.parse(read('_locales/en_XA/messages.json'));
const pages = ['onboarding/onboarding.html', 'privacy/privacy.html', 'settings/settings.html'];

describe('locale catalogs', () => {
  it('en_XA is in sync with the generated pseudo-locale (run scripts/build-locales.mjs)', () => {
    expect(xa).toEqual(pseudoLocalizeCatalog(en));
  });

  it('pseudo-locale marks and pads every message and keeps placeholders intact', () => {
    for (const [key, { message }] of Object.entries(xa)) {
      expect(message.startsWith('['), key).toBe(true);
      expect(message.length, key).toBeGreaterThan(en[key].message.length);
    }
    expect(pseudoLocalize('Hi $NAME$ $$')).toMatch(/\$NAME\$ \$\$/);
  });

  it('every message has non-empty text', () => {
    for (const [key, { message }] of Object.entries(en)) expect(message.trim(), key).not.toBe('');
  });
});

describe('page markup', () => {
  for (const page of pages) {
    const html = read(page);
    const keys = [...html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1]);

    it(`${page} only references defined message keys`, () => {
      for (const k of keys) expect(en[k], k).toBeDefined();
    });

    it(`${page} English fallback text matches the source catalog`, () => {
      for (const m of html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
        expect(m[2].replace(/\s+/g, ' ').trim(), m[1]).toBe(en[m[1]].message);
      }
    });

    it(`${page} loads i18n.js, declares lang and has a title`, () => {
      expect(html).toContain('i18n.js');
      expect(html).toMatch(/<html lang="en"/);
      expect(html).toMatch(/<title>[^<]+<\/title>/);
    });
  }

  it('every catalog key is used by some page', () => {
    const used = new Set(pages.flatMap((p) => [...read(p).matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1])));
    const manifestKeys = [...read('manifest.json').matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
    for (const k of Object.keys(en)) expect(used.has(k) || manifestKeys.includes(k), k).toBe(true);
  });
});

describe('first-run permission explanations', () => {
  it('explains every manifest permission and the optional host', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const onboarding = read('onboarding/onboarding.html');
    const explained = JSON.stringify(en);
    for (const perm of manifest.permissions) expect(explained, perm).toContain(perm);
    expect(onboarding).toContain('id="permissions"');
    for (const host of manifest.optional_host_permissions) expect(explained).toContain(new URL(host.replace('*', '')).host);
  });
});

describe('naming', () => {
  it('uses Token Watcher in user-facing files, never "ClaudeWatch Core"', () => {
    const files = [...pages, 'README.md', 'validate-manifest.js', 'popup/popup.html'];
    for (const f of files) expect(read(f), f).not.toMatch(/ClaudeWatch (Core|Extension)/);
    expect(readdirSync(join(root, '_locales')).sort()).toEqual(['en', 'en_XA']);
  });
});

describe('locale-aware formatting', () => {
  let I18n;
  beforeAll(async () => {
    globalThis.self = globalThis.self || {};
    await import('../i18n.js');
    I18n = self.TokenWatcherI18n;
  });

  const ts = Date.UTC(2026, 9, 23, 15, 30);
  it('formats dates differently per locale', () => {
    const us = I18n.formatDateTime(ts, { dateStyle: 'medium', timeZone: 'UTC' }, 'en-US');
    const de = I18n.formatDateTime(ts, { dateStyle: 'medium', timeZone: 'UTC' }, 'de-DE');
    expect(us).toBe('Oct 23, 2026');
    expect(de).not.toBe(us);
  });
  it('returns an empty string for invalid dates', () => {
    expect(I18n.formatDate('nope')).toBe('');
  });
  it('formats numbers by locale and falls back to English for the pseudo-locale', () => {
    expect(I18n.formatNumber(1234.5, undefined, 'de-DE')).toBe('1.234,5');
    expect(I18n.formatLocale()).toBeTruthy();
  });
  it('t() falls back to the supplied text or key without chrome.i18n', () => {
    expect(I18n.t('missing', undefined, 'Fallback')).toBe('Fallback');
    expect(I18n.t('missing')).toBe('missing');
  });
});
