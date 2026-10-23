import { currentView } from './ledger.js';
import { reconcile, type IntervalResult } from './reconcile.js';
import { CONFIDENCES, MEASUREMENT_METHODS, PROVIDERS, SOURCES } from './types.js';
import type { Confidence, LedgerRecord, LedgerSource, MeasurementMethod, Provider } from './types.js';

// Read model for the ledger UI (Prompt 1.5). Pure: it labels and filters records and
// reuses reconcile(); it never writes. See docs/LEDGER_UI.md for the wording rules.

export const EVIDENCE_LABELS = ['provider_reported', 'measured', 'estimated', 'reconciled', 'corrected', 'unattributed'] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

// Plain-text labels so no state relies on color. None implies exact billing.
export const LABEL_TEXT: Record<EvidenceLabel, string> = {
  provider_reported: 'Provider-reported',
  measured: 'Measured on this device',
  estimated: 'Estimated',
  reconciled: 'Reconciled (range)',
  corrected: 'Corrected by you',
  unattributed: 'Unattributed',
};

export const STALE_AFTER_MS = 30 * 60_000;
export const DEFAULT_ROW_LIMIT = 200;
export const MAX_ROW_LIMIT = 1000;

export interface LedgerFilter {
  provider?: Provider;
  account?: string;
  device?: string;
  client?: LedgerSource; // which collector or app produced the record (the ledger's `source` field)
  source?: MeasurementMethod; // how the value was obtained (the ledger's `measurementMethod`)
  confidence?: Confidence;
  from?: number; // epoch ms, inclusive
  to?: number; // epoch ms, exclusive
}

export function labelOf(r: LedgerRecord): EvidenceLabel {
  if (r.kind === 'provider_snapshot') return 'provider_reported';
  if (r.kind === 'reconciliation') return 'reconciled';
  if (r.kind === 'correction' || r.measurementMethod === 'user_correction') return 'corrected';
  if (r.source === 'unattributed') return 'unattributed';
  if (r.measurementMethod === 'local_log_parse') return 'measured';
  return 'estimated';
}

const inTime = (r: LedgerRecord, f: LedgerFilter) =>
  (f.from === undefined || r.effectiveObservedAt >= f.from) && (f.to === undefined || r.effectiveObservedAt < f.to);
const matchesScope = (r: LedgerRecord, f: LedgerFilter) =>
  (!f.provider || r.provider === f.provider) && (!f.account || r.accountAlias === f.account) && inTime(r, f);

export const matches = (r: LedgerRecord, f: LedgerFilter): boolean =>
  matchesScope(r, f) && (!f.device || r.devicePseudonym === f.device) && (!f.client || r.source === f.client) &&
  (!f.source || r.measurementMethod === f.source) && (!f.confidence || r.confidence === f.confidence);

export function parseFilter(q: Record<string, unknown>): { ok: true; filter: LedgerFilter } | { ok: false; error: string } {
  const f: LedgerFilter = {};
  const str = (k: string): string | undefined => (typeof q[k] === 'string' && q[k] !== '' ? (q[k] as string) : undefined);
  const oneOf = <T extends string>(k: string, allowed: readonly T[]): T | undefined | 'bad' => {
    const v = str(k);
    return v === undefined ? undefined : (allowed as readonly string[]).includes(v) ? (v as T) : 'bad';
  };
  const provider = oneOf('provider', PROVIDERS), client = oneOf('client', SOURCES), source = oneOf('source', MEASUREMENT_METHODS), confidence = oneOf('confidence', CONFIDENCES);
  if ([provider, client, source, confidence].includes('bad')) return { ok: false, error: 'invalid_filter_value' };
  if (provider) f.provider = provider as Provider;
  if (client) f.client = client as LedgerSource;
  if (source) f.source = source as MeasurementMethod;
  if (confidence) f.confidence = confidence as Confidence;
  const account = str('account'), device = str('device');
  if (account) { if (account.length > 64) return { ok: false, error: 'invalid_filter_value' }; f.account = account; }
  if (device) { if (!/^[a-f0-9]{8,64}$/.test(device)) return { ok: false, error: 'invalid_filter_value' }; f.device = device; }
  for (const k of ['from', 'to'] as const) {
    const v = str(k);
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'invalid_filter_value' };
    f[k] = n;
  }
  if (f.from !== undefined && f.to !== undefined && f.from >= f.to) return { ok: false, error: 'invalid_time_range' };
  return { ok: true, filter: f };
}

export interface LedgerRow {
  id: string; at: number; provider: Provider; account: string; device: string; client: LedgerSource;
  source: MeasurementMethod; confidence: Confidence; kind: LedgerRecord['kind']; label: EvidenceLabel; labelText: string;
  window?: string; quotaPercentUsed?: number; estimatedTokens?: number; requestCount?: number; flags: string[];
}

export interface QuotaChange {
  provider: Provider; account: string; window: string; from: number; to: number;
  providerDeltaPoints: number; attributedPoints: { low: number; high: number }; unattributedPoints: { low: number; high: number };
  evidenceCount: number; explanation: string; notes: string[];
}

export type ViewState = 'empty' | 'no_match' | 'stale' | 'partial' | 'ok';

export interface LedgerView {
  state: ViewState;
  stateReasons: string[];
  totalRecords: number;
  matched: number;
  truncated: boolean;
  rows: LedgerRow[];
  totalsByLabel: Record<EvidenceLabel, { records: number; requests: number; estimatedTokens: number }>;
  quotaChanges: QuotaChange[];
  providerMovementPoints: number; // sum of provider-reported increases inside the filtered scope
  unidentifiedPoints: { low: number; high: number }; // movement the ledger cannot attribute to evidence it holds
  lastProviderSnapshotAt: number | null;
  options: { providers: string[]; accounts: string[]; devices: string[]; clients: string[]; sources: string[]; confidences: string[] };
  caveat: string;
}

export const CAVEAT = 'Quota points come from the provider. Token figures are local estimates, not billing. Unattributed means the ledger holds no local evidence for that movement.';

const toRow = (r: LedgerRecord): LedgerRow => {
  const label = labelOf(r);
  const m = r.measures;
  return {
    id: r.id, at: r.effectiveObservedAt, provider: r.provider, account: r.accountAlias, device: r.devicePseudonym, client: r.source,
    source: r.measurementMethod, confidence: r.confidence, kind: r.kind, label, labelText: LABEL_TEXT[label],
    ...(r.window ? { window: r.window.type } : {}),
    ...(m.quotaPercentUsed !== undefined ? { quotaPercentUsed: m.quotaPercentUsed } : {}),
    ...(m.estimatedTokens !== undefined ? { estimatedTokens: m.estimatedTokens } : {}),
    ...(m.requestCount !== undefined ? { requestCount: m.requestCount } : {}),
    flags: r.flags,
  };
};

const toChange = (i: IntervalResult): QuotaChange => ({
  provider: i.provider, account: i.accountAlias, window: i.window, from: i.from, to: i.to, providerDeltaPoints: i.providerDelta,
  attributedPoints: { low: i.attributed.low, high: i.attributed.high }, unattributedPoints: { low: i.unattributed.low, high: i.unattributed.high },
  evidenceCount: i.evidence.recordIds.length, explanation: i.explanation, notes: i.notes,
});

const distinct = (xs: string[]) => [...new Set(xs)].sort();

export function buildLedgerView(all: LedgerRecord[], filter: LedgerFilter = {}, opts: { now: number; limit?: number }): LedgerView {
  const view = currentView(all);
  const limit = Math.min(MAX_ROW_LIMIT, Math.max(1, opts.limit ?? DEFAULT_ROW_LIMIT));
  const matched = view.filter(r => matches(r, filter));
  const scoped = view.filter(r => matchesScope(r, filter));

  const totalsByLabel = Object.fromEntries(EVIDENCE_LABELS.map(l => [l, { records: 0, requests: 0, estimatedTokens: 0 }])) as LedgerView['totalsByLabel'];
  for (const r of matched) {
    const t = totalsByLabel[labelOf(r)];
    t.records++; t.requests += r.measures.requestCount ?? 0; t.estimatedTokens += r.measures.estimatedTokens ?? 0;
  }

  const report = reconcile(scoped);
  const reconciled = report.intervals.filter(i => i.status === 'reconciled');
  const quotaChanges = reconciled.map(toChange);
  const unidentified = reconciled.reduce((a, i) => ({ low: a.low + i.unattributed.low, high: a.high + i.unattributed.high }), { low: 0, high: 0 });
  const movement = reconciled.reduce((n, i) => n + i.providerDelta, 0);
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

  const snaps = matched.filter(r => r.kind === 'provider_snapshot');
  const lastSnap = snaps.length ? Math.max(...snaps.map(r => r.effectiveObservedAt)) : null;
  const reasons: string[] = [];
  let state: ViewState = 'ok';
  if (view.length === 0) state = 'empty';
  else if (matched.length === 0) state = 'no_match';
  else {
    if (lastSnap !== null && opts.now - lastSnap > STALE_AFTER_MS) { state = 'stale'; reasons.push('provider_snapshot_old'); }
    if (lastSnap === null && matched.some(r => r.kind === 'local_activity')) { if (state === 'ok') state = 'partial'; reasons.push('no_provider_snapshots'); }
    if (quotaChanges.some(c => c.notes.includes('missing_snapshots'))) { if (state === 'ok') state = 'partial'; reasons.push('snapshot_gaps'); }
    if (matched.some(r => r.flags.length > 0)) { if (state === 'ok') state = 'partial'; reasons.push('flagged_records'); }
  }

  return {
    state, stateReasons: reasons, totalRecords: view.length, matched: matched.length, truncated: matched.length > limit,
    rows: matched.slice().reverse().slice(0, limit).map(toRow), totalsByLabel, quotaChanges,
    providerMovementPoints: r6(movement), unidentifiedPoints: { low: r6(unidentified.low), high: r6(unidentified.high) },
    lastProviderSnapshotAt: lastSnap,
    options: {
      providers: distinct(view.map(r => r.provider)), accounts: distinct(view.map(r => r.accountAlias)), devices: distinct(view.map(r => r.devicePseudonym)),
      clients: distinct(view.map(r => r.source)), sources: distinct(view.map(r => r.measurementMethod)), confidences: distinct(view.map(r => r.confidence)),
    },
    caveat: CAVEAT,
  };
}

export const filteredRows = (all: LedgerRecord[], filter: LedgerFilter): LedgerRow[] =>
  currentView(all).filter(r => matches(r, filter)).reverse().map(toRow);

const csvCell = (v: unknown): string => {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
  return `"${s.replace(/"/g, '""')}"`;
};

export function toCsv(rows: LedgerRow[]): string {
  const head = ['observed_at_iso', 'provider', 'account', 'device', 'client', 'measurement', 'confidence', 'kind', 'label', 'window', 'quota_percent_used', 'estimated_tokens', 'request_count', 'flags'];
  const lines = rows.map(r => [new Date(r.at).toISOString(), r.provider, r.account, r.device, r.client, r.source, r.confidence, r.kind, r.labelText, r.window, r.quotaPercentUsed, r.estimatedTokens, r.requestCount, r.flags.join(';')].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}
