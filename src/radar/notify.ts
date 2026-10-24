import { INCIDENT_KINDS, type Incident, type IncidentKind } from './detect.js';
import { PROVIDERS, type Provider } from './contribution.js';

// Local incident notification controls (prompt 4.3). Decides which incidents the user hears about; nothing leaves the device.

export interface RadarNotifyPrefs {
  /** Master switch. Off by default: Radar never notifies until the user opts in. */
  enabled: boolean;
  /** Minimum confidence, 0..1. */
  minConfidence: number;
  /** Empty means every provider. */
  providers: Provider[];
  /** Empty means every incident kind. */
  kinds: IncidentKind[];
  notifyOnResolved: boolean;
}

export const DEFAULT_NOTIFY_PREFS: RadarNotifyPrefs = Object.freeze({ enabled: false, minConfidence: 0.5, providers: [], kinds: [], notifyOnResolved: false }) as RadarNotifyPrefs;

const KEYS = ['enabled', 'minConfidence', 'providers', 'kinds', 'notifyOnResolved'];

export type PrefsResult = { ok: true; value: RadarNotifyPrefs } | { ok: false; errors: string[] };

const subset = <T extends string>(v: unknown, allowed: readonly T[]): T[] | null =>
  Array.isArray(v) && v.every(x => (allowed as readonly string[]).includes(x as string)) ? [...new Set(v as T[])] : null;

export function validatePrefs(input: unknown): PrefsResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: ['preferences must be an object'] };
  const o = input as Record<string, unknown>;
  const errors = Object.keys(o).filter(k => !KEYS.includes(k)).map(k => `unexpected field: ${k}`);
  if (typeof o['enabled'] !== 'boolean') errors.push('enabled must be a boolean');
  if (typeof o['notifyOnResolved'] !== 'boolean') errors.push('notifyOnResolved must be a boolean');
  const mc = o['minConfidence'];
  if (typeof mc !== 'number' || !Number.isFinite(mc) || mc < 0 || mc > 1) errors.push('minConfidence must be between 0 and 1');
  const providers = subset(o['providers'], PROVIDERS);
  if (!providers) errors.push('providers contains an unknown provider');
  const kinds = subset(o['kinds'], INCIDENT_KINDS);
  if (!kinds) errors.push('kinds contains an unknown incident kind');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { enabled: o['enabled'] as boolean, minConfidence: mc as number, providers: providers!, kinds: kinds!, notifyOnResolved: o['notifyOnResolved'] as boolean } };
}

/** Dedup key: an incident notifies once when active and once more if it resolves (when enabled). */
export const notificationKey = (i: Incident) => `${i.id}:${i.status}`;

export function selectNotifications(incidents: readonly Incident[], prefs: RadarNotifyPrefs, seen: ReadonlySet<string>): Incident[] {
  if (!prefs.enabled) return [];
  return incidents.filter(i =>
    (i.status === 'active' || prefs.notifyOnResolved) && i.confidence >= prefs.minConfidence &&
    (prefs.providers.length === 0 || prefs.providers.includes(i.provider)) &&
    (prefs.kinds.length === 0 || prefs.kinds.includes(i.kind)) && !seen.has(notificationKey(i)));
}
