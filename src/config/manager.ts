import fs from 'fs';
import path from 'path';
import os from 'os';
import { parse, stringify } from 'smol-toml';
import keytar from 'keytar';
import type { Config, ConfigFile, EmailConfig, EmailProvider, KeytarRef, Mode, SpendThreshold } from './schema.js';
import {
  API_KEY_ACCOUNT,
  DEFAULT_CONFIG_FILE,
  EMAIL_PASS_ACCOUNT,
  KEYTAR_SERVICE,
} from './schema.js';

const CONFIG_DIR = path.join(os.homedir(), '.claudewatch');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.toml');

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigFilePath(): string {
  return CONFIG_FILE;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export async function loadConfig(): Promise<Config> {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error('Not configured. Run: claudewatch setup');
  }

  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  const file = deserialize(parse(raw) as Record<string, unknown>);

  const anthropicAdminKey = await keytar.getPassword(
    file.apiKeyRef.service,
    file.apiKeyRef.account,
  );
  if (!anthropicAdminKey) {
    throw new Error('API key missing from keychain. Run: claudewatch setup');
  }

  const emailPassword = file.email !== null
    ? await keytar.getPassword(KEYTAR_SERVICE, EMAIL_PASS_ACCOUNT)
    : null;

  return {
    mode: file.mode,
    workspaceId: file.workspaceId,
    spendLimitUSD: file.spendLimitUSD,
    weeklySpendLimitUsd: file.weeklySpendLimitUsd,
    weeklyTokenLimit: file.weeklyTokenLimit,
    pollIntervalMinutes: file.pollIntervalMinutes,
    desktop: file.desktop,
    notifyOnEveryPrompt: file.notifyOnEveryPrompt,
    thresholds: file.thresholds,
    email: file.email,
    anthropicAdminKey,
    emailPassword,
  };
}

/** Parse a raw TOML-parsed object into a ConfigFile. Exported for unit tests. */
export function parseConfigFile(raw: Record<string, unknown>): ConfigFile {
  return deserialize(raw);
}

/** Persist TOML + store both secrets in keychain */
export async function saveConfig(
  file: ConfigFile,
  apiKey: string,
  emailPassword?: string,
): Promise<void> {
  writeToml(file);
  await keytar.setPassword(KEYTAR_SERVICE, API_KEY_ACCOUNT, apiKey);
  if (emailPassword !== undefined) {
    await keytar.setPassword(KEYTAR_SERVICE, EMAIL_PASS_ACCOUNT, emailPassword);
  }
}

/** Persist TOML only — leaves keychain untouched */
export function saveConfigFile(file: ConfigFile): void {
  writeToml(file);
}

export async function deleteSecrets(): Promise<void> {
  await keytar.deletePassword(KEYTAR_SERVICE, API_KEY_ACCOUNT);
  await keytar.deletePassword(KEYTAR_SERVICE, EMAIL_PASS_ACCOUNT);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function writeToml(file: ConfigFile): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, stringify(serialize(file)), 'utf-8');
}

/** Convert ConfigFile → plain object safe for smol-toml (no null values) */
function serialize(file: ConfigFile): Record<string, unknown> {
  const out: Record<string, unknown> = {
    apiKeyRef: { service: file.apiKeyRef.service, account: file.apiKeyRef.account },
    mode: file.mode,
    workspaceId: file.workspaceId,
    pollIntervalMinutes: file.pollIntervalMinutes,
    desktop: file.desktop,
    notifyOnEveryPrompt: file.notifyOnEveryPrompt,
  };
  if (file.spendLimitUSD !== null) out['spendLimitUSD'] = file.spendLimitUSD;
  if (file.weeklySpendLimitUsd !== null) out['weeklySpendLimitUsd'] = file.weeklySpendLimitUsd;
  if (file.weeklyTokenLimit !== null) out['weeklyTokenLimit'] = file.weeklyTokenLimit;
  if (file.thresholds.length > 0) out['thresholds'] = file.thresholds.map(t => ({ ...t }));
  if (file.email !== null) out['email'] = { ...file.email };
  return out;
}

/** Safely coerce the raw TOML parse result into ConfigFile */
function deserialize(raw: Record<string, unknown>): ConfigFile {
  return {
    apiKeyRef: parseKeytarRef(raw['apiKeyRef']),
    mode: asMode(raw['mode']),
    workspaceId: asString(raw['workspaceId'], DEFAULT_CONFIG_FILE.workspaceId),
    spendLimitUSD: typeof raw['spendLimitUSD'] === 'number' ? raw['spendLimitUSD'] : null,
    weeklySpendLimitUsd: typeof raw['weeklySpendLimitUsd'] === 'number' ? raw['weeklySpendLimitUsd'] : null,
    weeklyTokenLimit: typeof raw['weeklyTokenLimit'] === 'number' ? Math.round(raw['weeklyTokenLimit']) : null,
    pollIntervalMinutes: asInt(raw['pollIntervalMinutes'], DEFAULT_CONFIG_FILE.pollIntervalMinutes),
    desktop: asBool(raw['desktop'], DEFAULT_CONFIG_FILE.desktop),
    notifyOnEveryPrompt: asBool(raw['notifyOnEveryPrompt'], DEFAULT_CONFIG_FILE.notifyOnEveryPrompt),
    thresholds: parseThresholds(raw['thresholds']),
    email: isRecord(raw['email']) ? parseEmailConfig(raw['email']) : null,
  };
}

function parseKeytarRef(v: unknown): KeytarRef {
  if (!isRecord(v)) return { service: KEYTAR_SERVICE, account: API_KEY_ACCOUNT };
  return {
    service: asString(v['service'], KEYTAR_SERVICE),
    account: asString(v['account'], API_KEY_ACCOUNT),
  };
}

function parseThresholds(v: unknown): SpendThreshold[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord).map((t) => ({
    amountUsd: typeof t['amountUsd'] === 'number' ? t['amountUsd'] : 0,
    period: (['daily', 'weekly', 'monthly'] as const).includes(t['period'] as never)
      ? (t['period'] as SpendThreshold['period'])
      : 'daily',
    notifyEmail: asBool(t['notifyEmail'], false),
    notifyDesktop: asBool(t['notifyDesktop'], true),
  }));
}

function parseEmailConfig(raw: Record<string, unknown>): EmailConfig {
  return {
    provider: asEmailProvider(raw['provider']),
    host: asString(raw['host'], 'localhost'),
    port: asInt(raw['port'], 587),
    secure: asBool(raw['secure'], false),
    user: asString(raw['user'], ''),
    to: asString(raw['to'], ''),
  };
}

function asEmailProvider(v: unknown): EmailProvider {
  return v === 'sendgrid' ? 'sendgrid' : 'smtp';
}

function asMode(v: unknown): Mode {
  return v === 'personal' ? 'personal' : 'admin';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, def: string): string {
  return typeof v === 'string' ? v : def;
}

function asInt(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : def;
}

function asBool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}
