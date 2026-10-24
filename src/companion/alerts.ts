// Decides which push notifications a device asks the sync service to fan out (prompt 3.4).
// Output carries only an alert kind and an opaque dedupe key; usage values never leave the device in a notification.
import { riskNotice } from '../forecast/engine.js';
import type { Forecast } from '../forecast/engine.js';
import { sha256Hex } from '../sync/e2ee/crypto.js';
import type { SyncPrefs } from '../sync/e2ee/allowlist.js';
import type { PushKind } from '../sync/service/push.js';

export interface PendingAlert { kind: PushKind; dedupeKey: string }

/** One key per alert episode: the same window and reset time always hash to the same key, so repeats are suppressed. */
export async function dedupeKeyFor(kind: PushKind, f: Pick<Forecast, 'provider' | 'accountAlias' | 'window' | 'resetAt'>, bucket: number): Promise<string> {
  return (await sha256Hex(`${kind}|${f.provider}|${f.accountAlias}|${f.window}|${f.resetAt ?? 'none'}|${bucket}`)).slice(0, 32);
}

const ALERT_COOLDOWN_BUCKET_MS: Record<string, number> = { low: 24 * 3_600_000, normal: 6 * 3_600_000, high: 2 * 3_600_000 };

/**
 * Compare the previous and current forecasts of one provider/account/window. `quota_risk` reuses riskNotice (new or
 * materially changed risk only); `reset` fires once when a previously limited window has reset.
 */
export async function alertsFor(prev: Forecast | null, next: Forecast, prefs: SyncPrefs, now: number): Promise<PendingAlert[]> {
  const frequency = prefs.alertFrequency ?? 'normal';
  if (frequency === 'off' || prefs.providerMute?.[next.provider] === true) return [];
  const bucket = Math.floor(now / (ALERT_COOLDOWN_BUCKET_MS[frequency] ?? ALERT_COOLDOWN_BUCKET_MS['normal']!));
  const out: PendingAlert[] = [];
  if (riskNotice(prev, next).notify) out.push({ kind: 'quota_risk', dedupeKey: await dedupeKeyFor('quota_risk', next, bucket) });
  if (prev && prev.state === 'limited' && prev.resetAt !== null && prev.resetAt <= now && next.state !== 'limited') {
    out.push({ kind: 'reset', dedupeKey: await dedupeKeyFor('reset', prev, 0) });
  }
  return out;
}
