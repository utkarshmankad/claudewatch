// Versioned plan-pricing catalog (Prompt 5.1, operation key 2026-10-10.1/prompt-5.1). See docs/WRAPPED_METRICS.md.
import type { Provider } from '../ledger/types.js';

export const PRICING_SCHEMA_VERSION = 1;
export const TAX_TREATMENTS = ['included', 'excluded', 'unknown'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];
export const BILLING_PERIODS = ['monthly', 'annual'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export interface PriceEntry {
  provider: Provider;
  planId: string;
  currency: string; // ISO 4217, upper case
  region: string; // ISO 3166-1 alpha-2, or 'ZZ' when the price is not region specific
  amountMinor: number; // integer minor units (cents), price per billing period
  billing: BillingPeriod;
  taxTreatment: TaxTreatment;
  sourceUrl: string; // https page where the price was read
  effectiveFrom: number; // epoch ms UTC
  effectiveTo?: number; // exclusive; absent while current
}

export interface PricingCatalog { schemaVersion: number; entries: PriceEntry[] }

// A user-entered price replaces the catalog entry for one provider/plan. Never silently shared.
export interface ManualOverride { provider: Provider; planId: string; currency: string; amountMinor: number; billing: BillingPeriod; taxTreatment: TaxTreatment; note?: string }
export interface PlanChange { provider: Provider; accountAlias: string; planId: string; from: number } // plan active from this time until the next change

export type ResolvedPrice =
  | { ok: true; entry: PriceEntry; source: 'catalog' | 'override' }
  | { ok: false; reason: 'no_price' | 'ambiguous' };

export function validateCatalog(raw: unknown): { ok: true; catalog: PricingCatalog } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const c = raw as Partial<PricingCatalog> | null;
  if (!c || typeof c !== 'object') return { ok: false, errors: ['not_an_object'] };
  if (c.schemaVersion !== PRICING_SCHEMA_VERSION) errors.push('unsupported_schema_version');
  if (!Array.isArray(c.entries)) return { ok: false, errors: [...errors, 'entries_missing'] };
  c.entries.forEach((e: Partial<PriceEntry>, i) => {
    const bad = (m: string) => errors.push(`entries[${i}].${m}`);
    if (!e || typeof e !== 'object') { bad('invalid'); return; }
    if (typeof e.planId !== 'string' || !e.planId) bad('planId');
    if (typeof e.currency !== 'string' || !/^[A-Z]{3}$/.test(e.currency)) bad('currency');
    if (typeof e.region !== 'string' || !/^[A-Z]{2}$/.test(e.region)) bad('region');
    if (!Number.isInteger(e.amountMinor) || (e.amountMinor as number) < 0) bad('amountMinor');
    if (!(BILLING_PERIODS as readonly string[]).includes(e.billing as string)) bad('billing');
    if (!(TAX_TREATMENTS as readonly string[]).includes(e.taxTreatment as string)) bad('taxTreatment');
    if (typeof e.sourceUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(e.sourceUrl)) bad('sourceUrl');
    if (!Number.isFinite(e.effectiveFrom)) bad('effectiveFrom');
    if (e.effectiveTo !== undefined && !(Number.isFinite(e.effectiveTo) && (e.effectiveTo as number) > (e.effectiveFrom as number))) bad('effectiveTo');
  });
  return errors.length ? { ok: false, errors } : { ok: true, catalog: c as PricingCatalog };
}

const covers = (e: PriceEntry, at: number) => at >= e.effectiveFrom && (e.effectiveTo === undefined || at < e.effectiveTo);

// Override wins; otherwise the single catalog entry effective at `at` for the region/currency. Never guesses between entries.
export function resolvePrice(
  catalog: PricingCatalog, q: { provider: Provider; planId: string; region: string; currency?: string; at: number },
  overrides: ManualOverride[] = [],
): ResolvedPrice {
  const o = overrides.find(x => x.provider === q.provider && x.planId === q.planId);
  if (o) {
    const entry: PriceEntry = { provider: o.provider, planId: o.planId, currency: o.currency, region: q.region, amountMinor: o.amountMinor, billing: o.billing, taxTreatment: o.taxTreatment, sourceUrl: 'https://user.override.invalid/', effectiveFrom: 0 };
    return { ok: true, entry, source: 'override' };
  }
  const hits = catalog.entries.filter(e => e.provider === q.provider && e.planId === q.planId && covers(e, q.at) && (e.region === q.region || e.region === 'ZZ') && (!q.currency || e.currency === q.currency));
  const exact = hits.filter(e => e.region === q.region);
  const pool = exact.length ? exact : hits;
  if (pool.length === 0) return { ok: false, reason: 'no_price' };
  return pool.length === 1 ? { ok: true, entry: pool[0], source: 'catalog' } : { ok: false, reason: 'ambiguous' };
}

const DAY = 86_400_000;
// Cost of one day of a plan. Monthly: price x 12 / 365. Annual: price / 365. An estimate, not an invoice.
export const dailyCostMinor = (e: PriceEntry): number => (e.billing === 'monthly' ? (e.amountMinor * 12) / 365 : e.amountMinor / 365);

export interface PlanCostLine { provider: Provider; accountAlias: string; planId: string; currency: string; days: number; costMinor: number; taxTreatment: TaxTreatment; source: 'catalog' | 'override' }
export interface PlanCostResult { byCurrency: Record<string, number>; lines: PlanCostLine[]; missing: Array<{ provider: Provider; accountAlias: string; planId: string; reason: 'no_price' | 'ambiguous' }>; taxMixed: boolean }

// Prorates each plan to the days it was active inside [start, end). Currencies stay separate.
export function planCost(
  catalog: PricingCatalog, history: PlanChange[], period: { start: number; end: number; region: string },
  overrides: ManualOverride[] = [],
): PlanCostResult {
  const lines: PlanCostLine[] = [];
  const missing: PlanCostResult['missing'] = [];
  const groups = new Map<string, PlanChange[]>();
  for (const h of history) groups.set(`${h.provider}|${h.accountAlias}`, [...(groups.get(`${h.provider}|${h.accountAlias}`) ?? []), h]);
  for (const list of groups.values()) {
    list.sort((a, b) => a.from - b.from);
    list.forEach((h, i) => {
      const s = Math.max(h.from, period.start), e = Math.min(list[i + 1]?.from ?? period.end, period.end);
      if (e <= s) return;
      const r = resolvePrice(catalog, { provider: h.provider, planId: h.planId, region: period.region, at: s }, overrides);
      if (!r.ok) { missing.push({ provider: h.provider, accountAlias: h.accountAlias, planId: h.planId, reason: r.reason }); return; }
      const days = (e - s) / DAY;
      lines.push({ provider: h.provider, accountAlias: h.accountAlias, planId: h.planId, currency: r.entry.currency, days, costMinor: Math.round(dailyCostMinor(r.entry) * days), taxTreatment: r.entry.taxTreatment, source: r.source });
    });
  }
  const byCurrency: Record<string, number> = {};
  for (const l of lines) byCurrency[l.currency] = (byCurrency[l.currency] ?? 0) + l.costMinor;
  return { byCurrency, lines, missing, taxMixed: new Set(lines.map(l => l.taxTreatment)).size > 1 };
}
