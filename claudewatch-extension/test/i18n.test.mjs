import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pseudoLocalize, pseudoLocalizeCatalog } from '../lib/pseudo-locale.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const en = JSON.parse(read('_locales/en/messages.json'));
const xa = JSON.parse(read('_locales/en_XA/messages.json'));
const pages = ['onboarding/onboarding.html', 'privacy/privacy.html', 'settings/settings.html', 'popup/popup.html'];
const scripts = ['popup/popup.js', 'popup/ledger-summary.mjs', 'settings/settings.js'];

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
    const keys = [...html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g), ...html.matchAll(/data-i18n-attr="([^"]+)"/g)]
      .flatMap((m) => (m[0].startsWith('data-i18n-attr') ? m[1].split(';').map((p) => p.split(':')[1].trim()) : [m[1]]));

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
    const used = new Set([
      ...pages.flatMap((p) => [...read(p).matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1])),
      ...pages.flatMap((p) => [...read(p).matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((s) => s.split(':')[1].trim()))),
      ...scripts.flatMap((p) => [...read(p).matchAll(/\bt\('(\w+)'/g)].map((m) => m[1])),
    ]);
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
    for (const host of manifest.optional_host_permissions) expect(explained).toContain(new URL(host.replace(/\*/g, '')).host);
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

describe('script message keys', () => {
  for (const script of scripts) {
    it(`${script} only calls t() with defined keys`, () => {
      const src = read(script);
      for (const m of src.matchAll(/\bt\('(\w+)'/g)) expect(en[m[1]], m[1]).toBeDefined();
    });
  }
});

describe('accessibility basics', () => {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  for (const css of ['popup/popup.css', 'settings/settings.css']) {
    it(`${css}: secondary and muted text meet WCAG AA (4.5:1) on every surface`, () => {
      const src = read(css);
      const v = (name) => src.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))[1];
      for (const bg of ['bg-base', 'bg-raised', 'bg-card']) {
        for (const fg of ['text-primary', 'text-secondary', 'text-muted']) expect(ratio(v(fg), v(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${css}: defines a visible keyboard focus style`, () => {
      expect(read(css)).toMatch(/:focus-visible[^{]*\{[^}]*outline:\s*2px/);
    });
  }

  it('popup announces status changes and exposes tab state to screen readers', () => {
    const html = read('popup/popup.html');
    expect(html).toMatch(/id="alert"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="provider-health"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="tab-5h"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/id="sparkline"[^>]*role="img"[^>]*aria-label=/);
  });

  it('popup.html loads i18n.js before the popup module', () => {
    const html = read('popup/popup.html');
    expect(html.indexOf('i18n.js')).toBeGreaterThan(-1);
    expect(html.indexOf('i18n.js')).toBeLessThan(html.indexOf('popup.js'));
  });
});
