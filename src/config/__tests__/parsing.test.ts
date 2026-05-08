import { describe, it, expect, vi } from 'vitest';
import { parseConfigFile } from '../manager.js';
import { KEYTAR_SERVICE, API_KEY_ACCOUNT } from '../schema.js';

// Prevent the module-level `import keytar from 'keytar'` in manager.ts from
// touching the system keychain during unit tests.
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  },
}));

describe('parseConfigFile — top-level fields', () => {
  it('parses a fully-specified config', () => {
    const raw = {
      apiKeyRef: { service: 'claudewatch', account: 'anthropic-admin-key' },
      workspaceId: 'ws-abc',
      spendLimitUSD: 200,
      pollIntervalMinutes: 10,
      desktop: false,
      notifyOnEveryPrompt: true,
      thresholds: [],
      email: null,
    };

    const cfg = parseConfigFile(raw);

    expect(cfg.apiKeyRef).toEqual({ service: 'claudewatch', account: 'anthropic-admin-key' });
    expect(cfg.workspaceId).toBe('ws-abc');
    expect(cfg.spendLimitUSD).toBe(200);
    expect(cfg.pollIntervalMinutes).toBe(10);
    expect(cfg.desktop).toBe(false);
    expect(cfg.notifyOnEveryPrompt).toBe(true);
    expect(cfg.email).toBeNull();
  });

  it('applies defaults for a minimal (empty) raw object', () => {
    const cfg = parseConfigFile({});
    expect(cfg.workspaceId).toBe('');
    expect(cfg.spendLimitUSD).toBeNull();
    expect(cfg.pollIntervalMinutes).toBe(5);
    expect(cfg.desktop).toBe(true);
    expect(cfg.notifyOnEveryPrompt).toBe(false);
    expect(cfg.thresholds).toEqual([]);
    expect(cfg.email).toBeNull();
  });

  it('uses default apiKeyRef when the field is absent', () => {
    const cfg = parseConfigFile({});
    expect(cfg.apiKeyRef.service).toBe(KEYTAR_SERVICE);
    expect(cfg.apiKeyRef.account).toBe(API_KEY_ACCOUNT);
  });

  it('uses default apiKeyRef when the field is not a record', () => {
    const cfg = parseConfigFile({ apiKeyRef: 'bad-value' });
    expect(cfg.apiKeyRef.service).toBe(KEYTAR_SERVICE);
    expect(cfg.apiKeyRef.account).toBe(API_KEY_ACCOUNT);
  });

  it('returns null for spendLimitUSD when the value is not numeric', () => {
    expect(parseConfigFile({ spendLimitUSD: 'nope' }).spendLimitUSD).toBeNull();
    expect(parseConfigFile({ spendLimitUSD: null }).spendLimitUSD).toBeNull();
  });

  it('rounds pollIntervalMinutes to the nearest integer', () => {
    expect(parseConfigFile({ pollIntervalMinutes: 3.7 }).pollIntervalMinutes).toBe(4);
    expect(parseConfigFile({ pollIntervalMinutes: '5' }).pollIntervalMinutes).toBe(5);
  });

  it('falls back desktop to true when value is not boolean', () => {
    expect(parseConfigFile({ desktop: 'yes' }).desktop).toBe(true);
    expect(parseConfigFile({ desktop: 1 }).desktop).toBe(true);
  });
});

describe('parseConfigFile — threshold parsing', () => {
  it('returns an empty array when thresholds is not an array', () => {
    expect(parseConfigFile({ thresholds: null }).thresholds).toEqual([]);
    expect(parseConfigFile({ thresholds: 'bad' }).thresholds).toEqual([]);
    expect(parseConfigFile({ thresholds: {} }).thresholds).toEqual([]);
  });

  it('parses valid thresholds correctly', () => {
    const cfg = parseConfigFile({
      thresholds: [
        { amountUsd: 50, period: 'daily', notifyEmail: true, notifyDesktop: false },
        { amountUsd: 300, period: 'monthly', notifyEmail: false, notifyDesktop: true },
      ],
    });
    expect(cfg.thresholds).toHaveLength(2);
    expect(cfg.thresholds[0]).toEqual({ amountUsd: 50, period: 'daily', notifyEmail: true, notifyDesktop: false });
    expect(cfg.thresholds[1]).toEqual({ amountUsd: 300, period: 'monthly', notifyEmail: false, notifyDesktop: true });
  });

  it('accepts all three valid period values', () => {
    const periods = ['daily', 'weekly', 'monthly'] as const;
    for (const period of periods) {
      const [t] = parseConfigFile({
        thresholds: [{ amountUsd: 1, period, notifyEmail: false, notifyDesktop: false }],
      }).thresholds;
      expect(t?.period).toBe(period);
    }
  });

  it('falls back to "daily" when period is invalid', () => {
    const [t] = parseConfigFile({
      thresholds: [{ amountUsd: 10, period: 'quarterly', notifyEmail: false, notifyDesktop: true }],
    }).thresholds;
    expect(t?.period).toBe('daily');
  });

  it('defaults amountUsd to 0 when not a number', () => {
    const [t] = parseConfigFile({
      thresholds: [{ amountUsd: 'ten', period: 'daily', notifyEmail: false, notifyDesktop: false }],
    }).thresholds;
    expect(t?.amountUsd).toBe(0);
  });

  it('defaults notifyEmail/notifyDesktop when not booleans', () => {
    const [t] = parseConfigFile({
      thresholds: [{ amountUsd: 10, period: 'weekly' }],
    }).thresholds;
    expect(t?.notifyEmail).toBe(false);
    expect(t?.notifyDesktop).toBe(true);
  });

  it('skips non-record entries in the thresholds array', () => {
    const cfg = parseConfigFile({
      thresholds: [
        null,
        'string',
        42,
        { amountUsd: 5, period: 'daily', notifyEmail: false, notifyDesktop: false },
      ],
    });
    expect(cfg.thresholds).toHaveLength(1);
  });
});

describe('parseConfigFile — email config parsing', () => {
  it('returns null when email is absent or not a record', () => {
    expect(parseConfigFile({}).email).toBeNull();
    expect(parseConfigFile({ email: null }).email).toBeNull();
    expect(parseConfigFile({ email: 'smtp://...' }).email).toBeNull();
  });

  it('parses a complete SMTP email config', () => {
    const cfg = parseConfigFile({
      email: { provider: 'smtp', host: 'smtp.example.com', port: 465, secure: true, user: 'u@x.com', to: 'a@x.com' },
    });
    expect(cfg.email).toEqual({
      provider: 'smtp', host: 'smtp.example.com', port: 465, secure: true, user: 'u@x.com', to: 'a@x.com',
    });
  });

  it('parses the sendgrid provider', () => {
    const cfg = parseConfigFile({
      email: { provider: 'sendgrid', host: 'smtp.sendgrid.net', port: 587, secure: false, user: 'apikey', to: 'me@x.com' },
    });
    expect(cfg.email?.provider).toBe('sendgrid');
  });

  it('falls back to "smtp" for an unknown provider', () => {
    const cfg = parseConfigFile({ email: { provider: 'mailgun' } });
    expect(cfg.email?.provider).toBe('smtp');
  });

  it('applies defaults for missing email sub-fields', () => {
    const cfg = parseConfigFile({ email: {} });
    expect(cfg.email?.host).toBe('localhost');
    expect(cfg.email?.port).toBe(587);
    expect(cfg.email?.secure).toBe(false);
    expect(cfg.email?.user).toBe('');
    expect(cfg.email?.to).toBe('');
  });
});
