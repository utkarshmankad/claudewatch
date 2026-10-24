import { PARSER_RESULTS, PROVIDERS, type Provider } from './contribution.js';
import type { AuditAction, AuditEntry } from './remoteConfig.js';

// Local diagnostic report for support requests (prompt 4.3). Built from counts and versions only, shown in full for
// review, and exported only after the user confirms. No free text, identifiers, URLs or content can enter it.

export const DIAGNOSTIC_SCHEMA_VERSION = 1;

export interface DiagnosticInput {
  appVersion: string;
  extensionVersion?: string;
  radarContributionEnabled: boolean;
  radarNotificationsEnabled: boolean;
  remoteConfigVersion: number | null;
  audit: readonly AuditEntry[];
  parserCounts: readonly { provider: Provider; parserResult: (typeof PARSER_RESULTS)[number]; count: number }[];
}

export interface DiagnosticReport {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  appVersion: string;
  extensionVersion: string;
  radarContributionEnabled: boolean;
  radarNotificationsEnabled: boolean;
  remoteConfigVersion: number | null;
  remoteConfigEvents: Partial<Record<AuditAction, number>>;
  parserResults: { provider: Provider; parserResult: string; count: number }[];
}

export interface DiagnosticPreview {
  json: string;
  fields: { name: string; value: string }[];
  neverIncluded: string[];
  requiresReview: true;
}

export const NEVER_INCLUDED = ['Prompts or responses', 'Cookies, tokens or credentials', 'Your IP address, hostname or file paths', 'Email, account or organization identifiers', 'Usage amounts or activity times', 'Page URLs or titles'];

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const safeVersion = (v: string | undefined) => (v !== undefined && VERSION.test(v) ? v : 'unknown');
const count = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 1_000_000) : 0);

export function buildDiagnosticReport(i: DiagnosticInput): DiagnosticReport {
  const events: Partial<Record<AuditAction, number>> = {};
  for (const a of i.audit) events[a.action] = (events[a.action] ?? 0) + 1;
  const tally = new Map<string, number>();
  for (const p of i.parserCounts) {
    if (!(PROVIDERS as readonly string[]).includes(p.provider) || !(PARSER_RESULTS as readonly string[]).includes(p.parserResult)) continue;
    const k = `${p.provider}|${p.parserResult}`;
    tally.set(k, (tally.get(k) ?? 0) + count(p.count));
  }
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, appVersion: safeVersion(i.appVersion), extensionVersion: safeVersion(i.extensionVersion),
    radarContributionEnabled: i.radarContributionEnabled === true, radarNotificationsEnabled: i.radarNotificationsEnabled === true,
    remoteConfigVersion: i.remoteConfigVersion !== null && Number.isSafeInteger(i.remoteConfigVersion) ? i.remoteConfigVersion : null,
    remoteConfigEvents: events,
    parserResults: [...tally].sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => { const [provider, parserResult] = k.split('|') as [Provider, string]; return { provider, parserResult, count: c }; }),
  };
}

export function previewReport(r: DiagnosticReport): DiagnosticPreview {
  const show = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
  return {
    json: JSON.stringify(r, null, 2),
    fields: Object.entries(r).map(([name, v]) => ({ name, value: show(v) })),
    neverIncluded: NEVER_INCLUDED,
    requiresReview: true,
  };
}

/** The text a user may attach. Refuses until the user has confirmed they reviewed the preview. */
export function exportReport(r: DiagnosticReport, reviewed: boolean): string {
  if (!reviewed) throw new Error('Review the diagnostic report before exporting it.');
  return JSON.stringify(r, null, 2);
}
