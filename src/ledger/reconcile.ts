import { currentView, segments, RESET_PERCENT_DROP } from './ledger.js';
import type { LedgerRecord, LedgerSource, Provider, WindowType } from './types.js';

// Account-wide reconciliation. See docs/RECONCILIATION.md for the rules.
// Pure and deterministic: it reads the ledger and returns explanations. It never
// writes records, so ledger totals are never forced to match provider movement.

export const DEFAULT_MAX_GAP_MS = 60 * 60_000; // longer gaps between snapshots are flagged

export interface PercentPerToken { low: number; high: number } // quota percentage points per estimated token

export interface ReconcileOptions {
  // Calibration is an input, never invented here. Without it local activity is
  // evidence that something happened but supports no quantity, so nothing is attributed.
  calibration?: PercentPerToken;
  providerDelayMs?: number; // provider data lags reality; shifts the activity span back
  maxGapMs?: number;
}

export type IntervalStatus = 'reconciled' | 'excluded';
export type ExcludedReason = 'reset' | 'negative_correction' | 'no_movement';
export type Note =
  | 'no_calibration' | 'activity_unquantified' | 'activity_without_quota_movement'
  | 'other_account_activity_ignored' | 'missing_snapshots' | 'local_exceeds_provider' | 'simultaneous_clients';

export interface Range { low: number; point: number; high: number }

export interface IntervalResult {
  provider: Provider; accountAlias: string; window: WindowType;
  from: number; to: number; // snapshot times (effective observed time)
  status: IntervalStatus;
  excludedReason?: ExcludedReason;
  providerDelta: number; // percentage points reported by the provider between the two snapshots
  attributed: Range; // percentage points supported by local evidence
  unattributed: Range; // remainder: remote or unidentified activity
  bySource: Partial<Record<LedgerSource, number>>; // point estimate of attributed points per source
  evidence: { recordIds: string[]; devices: string[]; estimatedTokens: number };
  notes: Note[];
  explanation: string;
}

export interface Coverage { eligibleUnits: number; attributed: Range; coverage: Range | null; intervals: number; excluded: number }

export interface ReconciliationReport {
  intervals: IntervalResult[];
  // Per provider/account/window. Overlapping windows measure the same activity
  // in different units of quota, so they are never summed together.
  coverage: Record<string, Coverage>;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const iso = (t: number) => new Date(t).toISOString();
const groupKey = (provider: string, alias: string, window: string) => `${provider}|${alias}|${window}`;

function explain(i: Omit<IntervalResult, 'explanation'>): string {
  const span = `${iso(i.from)} to ${iso(i.to)}`;
  const head = `${i.provider}/${i.accountAlias}/${i.window} ${span}:`;
  if (i.status === 'excluded') {
    const why = {
      reset: 'a window reset occurred between the snapshots, so the interval is excluded from coverage',
      negative_correction: `the provider value fell by ${r6(-i.providerDelta)} points (within the ${RESET_PERCENT_DROP} point reset threshold), treated as a provider correction and excluded`,
      no_movement: 'the provider reported no quota movement',
    }[i.excludedReason as ExcludedReason];
    const extra = i.notes.includes('activity_without_quota_movement') ? ' Local activity was observed but did not move the reported quota.' : '';
    return `${head} ${why}.${extra}`;
  }
  const parts = [`${head} provider reported +${r6(i.providerDelta)} points.`];
  if (i.evidence.recordIds.length === 0) parts.push('No local activity was recorded in the interval.');
  else parts.push(`${i.evidence.recordIds.length} local observation(s) from ${i.evidence.devices.length} device(s), ${i.evidence.estimatedTokens} estimated tokens.`);
  if (i.notes.includes('no_calibration')) parts.push('No calibration is configured, so no quota is attributed to local activity.');
  else parts.push(`Attributed ${r6(i.attributed.point)} points (range ${r6(i.attributed.low)} to ${r6(i.attributed.high)}).`);
  parts.push(`Unattributed (remote or unidentified): ${r6(i.unattributed.point)} points (range ${r6(i.unattributed.low)} to ${r6(i.unattributed.high)}).`);
  if (i.notes.includes('local_exceeds_provider')) parts.push('Estimated local use exceeded the provider movement; attribution was capped at the provider delta.');
  if (i.notes.includes('missing_snapshots')) parts.push('The gap between snapshots is long, so snapshots may be missing.');
  if (i.notes.includes('other_account_activity_ignored')) parts.push('Activity under a different account alias was not attributed to this account.');
  if (i.notes.includes('simultaneous_clients')) parts.push('Several clients were active; attribution is shared in proportion to estimated tokens.');
  return parts.join(' ');
}

export function reconcile(all: LedgerRecord[], opts: ReconcileOptions = {}): ReconciliationReport {
  const view = currentView(all);
  const delay = opts.providerDelayMs ?? 0;
  const maxGap = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const activity = view.filter(r => r.kind === 'local_activity');
  const intervals: IntervalResult[] = [];

  const segs = segments(all);
  const byGroup = new Map<string, typeof segs>();
  for (const s of segs) {
    const k = groupKey(s.provider, s.accountAlias, s.window);
    byGroup.set(k, [...(byGroup.get(k) ?? []), s]);
  }

  for (const list of byGroup.values()) {
    const base = { provider: list[0].provider as Provider, accountAlias: list[0].accountAlias, window: list[0].window };
    const zero: Range = { low: 0, point: 0, high: 0 };
    list.forEach((seg, si) => {
      if (si > 0) {
        const prev = list[si - 1].points.at(-1)!;
        const cur = seg.points[0];
        const partial = { ...base, from: prev.at, to: cur.at, status: 'excluded' as const, excludedReason: 'reset' as const, providerDelta: 0, attributed: zero, unattributed: zero, bySource: {}, evidence: { recordIds: [], devices: [], estimatedTokens: 0 }, notes: [] as Note[] };
        intervals.push({ ...partial, explanation: explain(partial) });
      }
      for (let p = 1; p < seg.points.length; p++) {
        const a = seg.points[p - 1], b = seg.points[p];
        const delta = r6(b.percent - a.percent);
        const lo = a.at - delay, hi = b.at - delay;
        const inSpan = activity.filter(r => r.effectiveObservedAt > lo && r.effectiveObservedAt <= hi && r.provider === base.provider);
        const mine = inSpan.filter(r => r.accountAlias === base.accountAlias);
        const notes: Note[] = [];
        if (inSpan.length > mine.length) notes.push('other_account_activity_ignored');
        if (b.at - a.at > maxGap) notes.push('missing_snapshots');
        const evidence = { recordIds: mine.map(r => r.id), devices: [...new Set(mine.map(r => r.devicePseudonym))].sort(), estimatedTokens: mine.reduce((n, r) => n + (r.measures.estimatedTokens ?? 0), 0) };
        const clients = new Set(mine.map(r => `${r.devicePseudonym}|${r.source}`));
        if (clients.size > 1) notes.push('simultaneous_clients');

        if (delta <= 0) {
          if (mine.length) notes.push('activity_without_quota_movement');
          const partial = { ...base, from: a.at, to: b.at, status: 'excluded' as const, excludedReason: (delta < 0 ? 'negative_correction' : 'no_movement') as ExcludedReason, providerDelta: delta, attributed: zero, unattributed: zero, bySource: {}, evidence, notes };
          intervals.push({ ...partial, explanation: explain(partial) });
          continue;
        }

        let attributed: Range = zero;
        const bySource: Partial<Record<LedgerSource, number>> = {};
        if (!opts.calibration) {
          notes.push('no_calibration');
        } else if (evidence.estimatedTokens === 0) {
          if (mine.length) notes.push('activity_unquantified');
        } else {
          const cap = (x: number) => Math.min(delta, x);
          const low = cap(evidence.estimatedTokens * opts.calibration.low);
          const high = cap(evidence.estimatedTokens * opts.calibration.high);
          if (evidence.estimatedTokens * opts.calibration.high > delta) notes.push('local_exceeds_provider');
          attributed = { low: r6(low), point: r6((low + high) / 2), high: r6(high) };
          for (const r of mine) {
            const t = r.measures.estimatedTokens ?? 0;
            if (t > 0) bySource[r.source] = r6((bySource[r.source] ?? 0) + attributed.point * t / evidence.estimatedTokens);
          }
        }
        const unattributed: Range = { low: r6(delta - attributed.high), point: r6(delta - attributed.point), high: r6(delta - attributed.low) };
        const partial = { ...base, from: a.at, to: b.at, status: 'reconciled' as const, providerDelta: delta, attributed, unattributed, bySource, evidence, notes };
        intervals.push({ ...partial, explanation: explain(partial) });
      }
    });
  }

  intervals.sort((x, y) => x.from - y.from || x.to - y.to || (groupKey(x.provider, x.accountAlias, x.window) < groupKey(y.provider, y.accountAlias, y.window) ? -1 : 1));

  const coverage: Record<string, Coverage> = {};
  for (const i of intervals) {
    const k = groupKey(i.provider, i.accountAlias, i.window);
    const c = (coverage[k] ??= { eligibleUnits: 0, attributed: { low: 0, point: 0, high: 0 }, coverage: null, intervals: 0, excluded: 0 });
    if (i.status === 'excluded') { c.excluded++; continue; }
    c.intervals++;
    c.eligibleUnits = r6(c.eligibleUnits + i.providerDelta);
    c.attributed = { low: r6(c.attributed.low + i.attributed.low), point: r6(c.attributed.point + i.attributed.point), high: r6(c.attributed.high + i.attributed.high) };
  }
  for (const c of Object.values(coverage)) {
    c.coverage = c.eligibleUnits > 0 ? { low: r6(c.attributed.low / c.eligibleUnits), point: r6(c.attributed.point / c.eligibleUnits), high: r6(c.attributed.high / c.eligibleUnits) } : null;
  }
  return { intervals, coverage };
}
