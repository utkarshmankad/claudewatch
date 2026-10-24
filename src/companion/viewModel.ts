// Companion view model (prompt 3.4): what the installable companion shows, built only from the synced allow-list.
// No prompt, response, cookie, token, URL or raw account identifier can reach it: its inputs are SyncLedgerRecord
// (docs/sync/ARCHITECTURE.md), SyncPrefs and device health. Pure and deterministic.
import { forecast } from '../forecast/engine.js';
import type { Forecast } from '../forecast/engine.js';
import type { LedgerRecord, Provider, WindowType } from '../ledger/types.js';
import { PROVIDERS } from '../ledger/types.js';
import { recommend } from '../recommend/policy.js';
import type { Recommendation } from '../recommend/policy.js';
import type { SyncLedgerRecord, SyncPrefs } from '../sync/e2ee/allowlist.js';

const HOUR = 3_600_000;
export const SYNC_STALE_AFTER_MS = 6 * HOUR; // cloud sync older than this is shown as stale, never as current
export const DEVICE_STALE_AFTER_MS = 24 * HOUR;
const WINDOWS: WindowType[] = ['five_hour', 'weekly', 'daily'];

export interface DeviceHealthInput { name: string | null; lastSeenAt: number; revoked: boolean; current: boolean }

export interface CompanionInput {
  records: SyncLedgerRecord[];
  prefs: SyncPrefs;
  devices: DeviceHealthInput[];
  lastSyncAt: number | null;
  now: number;
}

export type Risk = 'none' | 'watch' | 'high';

export interface QuotaRow {
  provider: Provider;
  accountAlias: string;
  window: WindowType;
  usedPercent: number | null;
  resetAt: number | null;
  hoursToReset: number | null;
  asOf: number | null;
  state: Forecast['state'];
  risk: Risk;
  confidence: Forecast['confidence'];
}

export interface CompanionView {
  generatedAt: number;
  sync: { lastSyncAt: number | null; freshness: 'fresh' | 'stale' | 'never' };
  quotas: QuotaRow[];
  recommendation: { action: Recommendation['action']; provider: Provider | null; accountAlias: string | null; waitUntil: number | null; confidence: Recommendation['confidence']; summary: string } | null;
  devices: Array<{ name: string; lastSeenAt: number; health: 'ok' | 'stale' | 'revoked'; current: boolean }>;
  notifications: { alertFrequency: string; mutedProviders: Provider[]; quietHours: { startMinute: number; endMinute: number } | null };
}

/** Sync records carry no schemaVersion, ingest time or flags; the companion only reads, so it fills neutral values. */
export function toLedgerRecord(r: SyncLedgerRecord): LedgerRecord {
  return {
    ...r,
    schemaVersion: 1,
    kind: r.kind as LedgerRecord['kind'],
    provider: r.provider as Provider,
    source: r.source as LedgerRecord['source'],
    confidence: r.confidence as LedgerRecord['confidence'],
    measurementMethod: r.measurementMethod as LedgerRecord['measurementMethod'],
    window: r.window ? { type: r.window.type as WindowType, ...(r.window.resetAt !== undefined ? { resetAt: r.window.resetAt } : {}) } : undefined,
    correctionReason: r.correctionReason as LedgerRecord['correctionReason'],
    ingestedAt: r.observedAt,
    effectiveObservedAt: r.observedAt,
    flags: [],
  };
}

export function riskOf(f: Forecast): Risk {
  if (f.state === 'limited') return 'high';
  const p = f.probabilityExhaustBeforeReset ?? 0;
  if (f.state === 'ok' && p >= 0.8) return 'high';
  if (f.state === 'ok' && p >= 0.4) return 'watch';
  return 'none';
}

/** Forecasts for every provider/account/window that has at least one provider reading. */
export function forecastsFor(records: SyncLedgerRecord[], now: number, reservedPercent = 0): Forecast[] {
  const ledger = records.map(toLedgerRecord);
  const seen = new Set<string>();
  const out: Forecast[] = [];
  for (const r of ledger) {
    if (r.kind !== 'provider_snapshot' || r.measures.quotaPercentUsed === undefined || !r.window) continue;
    if (!WINDOWS.includes(r.window.type)) continue;
    const key = `${r.provider}|${r.accountAlias}|${r.window.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(forecast(ledger, { now, provider: r.provider, accountAlias: r.accountAlias, window: r.window.type, reservedPercent }));
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.accountAlias.localeCompare(b.accountAlias) || a.window.localeCompare(b.window));
}

export function buildCompanionView(input: CompanionInput): CompanionView {
  const { prefs, now } = input;
  const muted = PROVIDERS.filter((p) => prefs.providerMute?.[p] === true);
  const forecasts = forecastsFor(input.records, now);
  const quotas: QuotaRow[] = forecasts.map((f) => ({
    provider: f.provider, accountAlias: f.accountAlias, window: f.window, usedPercent: f.usedPercent, resetAt: f.resetAt,
    hoursToReset: f.hoursToReset, asOf: f.asOf, state: f.state, risk: riskOf(f), confidence: f.confidence,
  }));

  let recommendation: CompanionView['recommendation'] = null;
  const groups = new Map<string, Forecast[]>();
  for (const f of forecasts) {
    const key = `${f.provider}|${f.accountAlias}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  if (groups.size > 0) {
    const rec = recommend(
      [...groups.values()].map((fs) => ({ provider: fs[0]!.provider, accountAlias: fs[0]!.accountAlias, authenticated: true, health: 'ok' as const, forecasts: fs })),
      { excluded: muted },
      now,
    );
    recommendation = { action: rec.action, provider: rec.provider, accountAlias: rec.accountAlias, waitUntil: rec.waitUntil, confidence: rec.confidence, summary: rec.explanation };
  }

  const sync = {
    lastSyncAt: input.lastSyncAt,
    freshness: input.lastSyncAt === null ? ('never' as const) : now - input.lastSyncAt > SYNC_STALE_AFTER_MS ? ('stale' as const) : ('fresh' as const),
  };

  return {
    generatedAt: now,
    sync,
    quotas,
    recommendation,
    devices: input.devices.map((d) => ({
      name: d.name ?? 'Unnamed device',
      lastSeenAt: d.lastSeenAt,
      health: d.revoked ? ('revoked' as const) : now - d.lastSeenAt > DEVICE_STALE_AFTER_MS ? ('stale' as const) : ('ok' as const),
      current: d.current,
    })),
    notifications: { alertFrequency: prefs.alertFrequency ?? 'normal', mutedProviders: muted, quietHours: prefs.quietHours ?? null },
  };
}
