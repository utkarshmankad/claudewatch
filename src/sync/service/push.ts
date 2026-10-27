// Push subscription lifecycle for the companion (prompt 3.4). Pure helpers; the routes live in handler.ts.
// The service never sees usage values here: a push payload is only a schema version and an alert kind.

export const PUSH_KINDS = ['quota_risk', 'reset'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export interface QuietHours {
  startMinute: number; // minutes after local midnight, 0..1439
  endMinute: number; // exclusive; may be earlier than start to wrap midnight
  utcOffsetMinutes: number; // device's offset at subscription time; renew to follow DST changes
}

export interface PushSubscriptionRecord {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
  expiresAt: number;
  quietHours: QuietHours | null;
  kinds: PushKind[];
}

export interface PushMessage {
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: string; // generic JSON, see pushPayload()
  ttlSeconds: number;
  urgency: 'normal' | 'low';
}

/** Delivery transport. The owner supplies a Web Push implementation with VAPID keys; the repo ships none. */
export type PushSender = (message: PushMessage) => Promise<{ status: number }>;

// Only hosted browser push services may be targeted, so a registered endpoint cannot make the service call an arbitrary URL.
// An entry is an exact host, or "*.example.com" for one or more labels in front of example.com (never example.com itself).
// Only Windows hands out per-device sub-domains; the other services use one fixed host, so a take-over of some other
// sub-domain of googleapis.com, mozilla.com or apple.com is not a valid target.
export const DEFAULT_PUSH_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  '*.notify.windows.com',
];
/** @deprecated kept for older imports; the list is now exact hosts plus one wildcard. */
export const DEFAULT_PUSH_HOST_SUFFIXES = DEFAULT_PUSH_HOSTS;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  return hosts.some((h) => {
    if (!h.startsWith('*.')) return host === h;
    const base = h.slice(1); // ".example.com"
    if (!host.endsWith(base)) return false;
    const labels = host.slice(0, host.length - base.length).split('.');
    return labels.every((l) => LABEL.test(l));
  });
}

export class PushValidationError extends Error {}

export function validatePushEndpoint(raw: unknown, hosts: readonly string[] = DEFAULT_PUSH_HOSTS): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) throw new PushValidationError('endpoint');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PushValidationError('endpoint');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') throw new PushValidationError('endpoint');
  const host = url.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.includes('[')) throw new PushValidationError('endpoint'); // IP literals
  if (!hostAllowed(host, hosts)) throw new PushValidationError('endpoint_host');
  return url.toString();
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function validatePushKeys(p256dh: unknown, auth: unknown): { p256dh: string; auth: string } {
  if (typeof p256dh !== 'string' || p256dh.length < 16 || p256dh.length > 128 || !B64URL.test(p256dh)) throw new PushValidationError('p256dh');
  if (typeof auth !== 'string' || auth.length < 8 || auth.length > 64 || !B64URL.test(auth)) throw new PushValidationError('auth');
  return { p256dh, auth };
}

export function validateQuietHours(raw: unknown): QuietHours | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new PushValidationError('quiet_hours');
  const q = raw as Record<string, unknown>;
  const keys = Object.keys(q);
  if (keys.some((k) => !['startMinute', 'endMinute', 'utcOffsetMinutes'].includes(k))) throw new PushValidationError('quiet_hours');
  const int = (v: unknown, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new PushValidationError('quiet_hours');
    return v;
  };
  return { startMinute: int(q['startMinute'], 0, 1439), endMinute: int(q['endMinute'], 0, 1439), utcOffsetMinutes: int(q['utcOffsetMinutes'], -840, 840) };
}

export function validateKinds(raw: unknown): PushKind[] {
  if (raw === undefined) return [...PUSH_KINDS];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PUSH_KINDS.length) throw new PushValidationError('kinds');
  const out = new Set<PushKind>();
  for (const k of raw) {
    if (!(PUSH_KINDS as readonly unknown[]).includes(k)) throw new PushValidationError('kinds');
    out.add(k as PushKind);
  }
  return [...out];
}

/** True when `now` falls inside the quiet window. Equal start and end mean "no quiet hours", not "always quiet". */
export function inQuietHours(now: number, q: QuietHours | null): boolean {
  if (!q || q.startMinute === q.endMinute) return false;
  const local = (((Math.floor(now / 60_000) + q.utcOffsetMinutes) % 1440) + 1440) % 1440;
  return q.startMinute < q.endMinute ? local >= q.startMinute && local < q.endMinute : local >= q.startMinute || local < q.endMinute;
}

/** The whole push payload. No provider, account, percentage or time: the companion fetches content itself after waking. */
export function pushPayload(kind: PushKind): string {
  return JSON.stringify({ v: 1, k: kind });
}

export function pushTtlSeconds(kind: PushKind): number {
  return kind === 'reset' ? 30 * 60 : 60 * 60; // a stale quota alert is worse than none
}
