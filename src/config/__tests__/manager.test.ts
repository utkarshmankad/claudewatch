import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Mock modules with side-effects / native bindings
// ---------------------------------------------------------------------------

const mockKeytarGetPassword = vi.hoisted(() => vi.fn());
const mockKeytarSetPassword = vi.hoisted(() => vi.fn());
const mockKeytarDeletePassword = vi.hoisted(() => vi.fn());

vi.mock('keytar', () => ({
  default: {
    getPassword: mockKeytarGetPassword,
    setPassword: mockKeytarSetPassword,
    deletePassword: mockKeytarDeletePassword,
  },
}));

const mockFsExistsSync = vi.hoisted(() => vi.fn());
const mockFsMkdirSync = vi.hoisted(() => vi.fn());
const mockFsWriteFileSync = vi.hoisted(() => vi.fn());
const mockFsReadFileSync = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  default: {
    existsSync: mockFsExistsSync,
    mkdirSync: mockFsMkdirSync,
    writeFileSync: mockFsWriteFileSync,
    readFileSync: mockFsReadFileSync,
  },
}));

import {
  getConfigDir,
  getConfigFilePath,
  configExists,
  parseConfigFile,
  saveConfigFile,
  saveConfig,
  deleteSecrets,
} from '../manager.js';
import { KEYTAR_SERVICE, API_KEY_ACCOUNT, EMAIL_PASS_ACCOUNT } from '../schema.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('getConfigDir', () => {
  it('returns a path ending with .claudewatch', () => {
    expect(getConfigDir()).toEqual(path.join(os.homedir(), '.claudewatch'));
  });
});

describe('getConfigFilePath', () => {
  it('returns a path ending with config.toml', () => {
    expect(getConfigFilePath()).toMatch(/config\.toml$/);
  });

  it('is inside getConfigDir()', () => {
    expect(getConfigFilePath()).toContain(getConfigDir());
  });
});

// ---------------------------------------------------------------------------
// configExists
// ---------------------------------------------------------------------------

describe('configExists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when the config file exists', () => {
    mockFsExistsSync.mockReturnValueOnce(true);
    expect(configExists()).toBe(true);
  });

  it('returns false when the config file does not exist', () => {
    mockFsExistsSync.mockReturnValueOnce(false);
    expect(configExists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseConfigFile — pure deserialization, no mocks needed
// ---------------------------------------------------------------------------

describe('parseConfigFile', () => {
  it('applies defaults for missing fields', () => {
    const result = parseConfigFile({ apiKeyRef: {} });
    expect(result.mode).toBe('admin');
    expect(result.pollIntervalMinutes).toBe(5);
    expect(result.desktop).toBe(true);
    expect(result.notifyOnEveryPrompt).toBe(false);
    expect(result.spendLimitUSD).toBeNull();
    expect(result.weeklySpendLimitUsd).toBeNull();
    expect(result.weeklyTokenLimit).toBeNull();
    expect(result.thresholds).toEqual([]);
    expect(result.email).toBeNull();
  });

  it('parses mode correctly', () => {
    expect(parseConfigFile({ mode: 'personal' }).mode).toBe('personal');
    expect(parseConfigFile({ mode: 'admin' }).mode).toBe('admin');
    expect(parseConfigFile({ mode: 'unknown' }).mode).toBe('admin');
    expect(parseConfigFile({}).mode).toBe('admin');
  });

  it('parses numeric spend limits', () => {
    const result = parseConfigFile({ spendLimitUSD: 100, weeklySpendLimitUsd: 50 });
    expect(result.spendLimitUSD).toBe(100);
    expect(result.weeklySpendLimitUsd).toBe(50);
  });

  it('rounds weeklyTokenLimit to integer', () => {
    expect(parseConfigFile({ weeklyTokenLimit: 1000.7 }).weeklyTokenLimit).toBe(1001);
    expect(parseConfigFile({ weeklyTokenLimit: 500 }).weeklyTokenLimit).toBe(500);
    expect(parseConfigFile({ weeklyTokenLimit: 'not-a-number' }).weeklyTokenLimit).toBeNull();
  });

  it('falls back to null for non-numeric spend limits', () => {
    const result = parseConfigFile({ spendLimitUSD: 'bad', weeklySpendLimitUsd: null });
    expect(result.spendLimitUSD).toBeNull();
    expect(result.weeklySpendLimitUsd).toBeNull();
  });

  it('parses boolean desktop and notifyOnEveryPrompt', () => {
    const result = parseConfigFile({ desktop: false, notifyOnEveryPrompt: true });
    expect(result.desktop).toBe(false);
    expect(result.notifyOnEveryPrompt).toBe(true);
  });

  it('defaults boolean fields for non-boolean input', () => {
    const result = parseConfigFile({ desktop: 'yes', notifyOnEveryPrompt: 1 });
    expect(result.desktop).toBe(true);
    expect(result.notifyOnEveryPrompt).toBe(false);
  });

  it('parses thresholds array', () => {
    const result = parseConfigFile({
      thresholds: [
        { amountUsd: 10, period: 'daily', notifyEmail: true, notifyDesktop: false },
        { amountUsd: 50, period: 'weekly', notifyEmail: false, notifyDesktop: true },
      ],
    });
    expect(result.thresholds).toHaveLength(2);
    expect(result.thresholds[0]).toEqual({ amountUsd: 10, period: 'daily', notifyEmail: true, notifyDesktop: false });
    expect(result.thresholds[1]).toEqual({ amountUsd: 50, period: 'weekly', notifyEmail: false, notifyDesktop: true });
  });

  it('defaults invalid threshold period to "daily"', () => {
    const result = parseConfigFile({
      thresholds: [{ amountUsd: 5, period: 'hourly', notifyEmail: false, notifyDesktop: true }],
    });
    expect(result.thresholds[0]?.period).toBe('daily');
  });

  it('accepts "monthly" as a valid period', () => {
    const result = parseConfigFile({
      thresholds: [{ amountUsd: 100, period: 'monthly', notifyEmail: false, notifyDesktop: true }],
    });
    expect(result.thresholds[0]?.period).toBe('monthly');
  });

  it('filters out non-object entries in thresholds array', () => {
    const result = parseConfigFile({ thresholds: [null, 'bad', 42, { amountUsd: 5, period: 'daily', notifyEmail: false, notifyDesktop: true }] });
    expect(result.thresholds).toHaveLength(1);
  });

  it('returns empty thresholds for non-array input', () => {
    expect(parseConfigFile({ thresholds: 'bad' }).thresholds).toEqual([]);
    expect(parseConfigFile({ thresholds: null }).thresholds).toEqual([]);
  });

  it('parses email config when present', () => {
    const result = parseConfigFile({
      email: {
        provider: 'sendgrid',
        host: 'smtp.sendgrid.net',
        port: 587,
        secure: false,
        user: 'user@example.com',
        to: 'owner@example.com',
      },
    });
    expect(result.email).not.toBeNull();
    expect(result.email?.provider).toBe('sendgrid');
    expect(result.email?.to).toBe('owner@example.com');
  });

  it('defaults unknown email provider to "smtp"', () => {
    const result = parseConfigFile({ email: { provider: 'mailgun', host: 'x', port: 25, secure: false, user: 'u', to: 't' } });
    expect(result.email?.provider).toBe('smtp');
  });

  it('uses default host/port/secure for email when fields are missing', () => {
    const result = parseConfigFile({ email: { user: 'u', to: 't' } });
    expect(result.email?.host).toBe('localhost');
    expect(result.email?.port).toBe(587);
    expect(result.email?.secure).toBe(false);
  });

  it('parses apiKeyRef fields, falling back to defaults', () => {
    const result = parseConfigFile({ apiKeyRef: { service: 'my-svc', account: 'my-account' } });
    expect(result.apiKeyRef.service).toBe('my-svc');
    expect(result.apiKeyRef.account).toBe('my-account');
  });

  it('uses default apiKeyRef when not an object', () => {
    const result = parseConfigFile({ apiKeyRef: 'not-an-object' });
    expect(result.apiKeyRef.service).toBe(KEYTAR_SERVICE);
    expect(result.apiKeyRef.account).toBe(API_KEY_ACCOUNT);
  });

  it('asInt rounds floats to integers', () => {
    expect(parseConfigFile({ pollIntervalMinutes: 2.9 }).pollIntervalMinutes).toBe(3);
  });

  it('asInt uses default for non-numeric input', () => {
    expect(parseConfigFile({ pollIntervalMinutes: 'ten' }).pollIntervalMinutes).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// saveConfigFile — writes TOML to disk (fs mocked)
// ---------------------------------------------------------------------------

describe('saveConfigFile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls fs.mkdirSync and fs.writeFileSync', () => {
    const file = parseConfigFile({});
    saveConfigFile(file);
    expect(mockFsMkdirSync).toHaveBeenCalledOnce();
    expect(mockFsWriteFileSync).toHaveBeenCalledOnce();
    const [writePath, content] = mockFsWriteFileSync.mock.calls[0] as [string, string, string];
    expect(writePath).toMatch(/config\.toml$/);
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// saveConfig — writes TOML + stores secrets in keychain
// ---------------------------------------------------------------------------

describe('saveConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores the API key in keychain', async () => {
    mockKeytarSetPassword.mockResolvedValue(undefined);
    await saveConfig(parseConfigFile({}), 'sk-admin-key');
    expect(mockKeytarSetPassword).toHaveBeenCalledWith(KEYTAR_SERVICE, API_KEY_ACCOUNT, 'sk-admin-key');
  });

  it('stores the email password when provided', async () => {
    mockKeytarSetPassword.mockResolvedValue(undefined);
    await saveConfig(parseConfigFile({}), 'sk-admin-key', 'email-pass');
    expect(mockKeytarSetPassword).toHaveBeenCalledWith(KEYTAR_SERVICE, EMAIL_PASS_ACCOUNT, 'email-pass');
  });

  it('does not store email password when not provided', async () => {
    mockKeytarSetPassword.mockResolvedValue(undefined);
    await saveConfig(parseConfigFile({}), 'sk-admin-key');
    const calls = mockKeytarSetPassword.mock.calls.map(c => c[1]);
    expect(calls).not.toContain(EMAIL_PASS_ACCOUNT);
  });
});

// ---------------------------------------------------------------------------
// deleteSecrets
// ---------------------------------------------------------------------------

describe('deleteSecrets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes both secrets from keychain', async () => {
    mockKeytarDeletePassword.mockResolvedValue(true);
    await deleteSecrets();
    expect(mockKeytarDeletePassword).toHaveBeenCalledWith(KEYTAR_SERVICE, API_KEY_ACCOUNT);
    expect(mockKeytarDeletePassword).toHaveBeenCalledWith(KEYTAR_SERVICE, EMAIL_PASS_ACCOUNT);
  });
});
