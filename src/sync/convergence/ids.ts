// Deterministic identifiers: event ids come from record content and aliases from the provider account,
// so every device derives the same value without a clock, a counter or a server round trip.
import { sha256Hex } from '../e2ee/crypto.js';

/** JSON with sorted keys, so equal content always serializes to equal bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Content hash of a ledger record without its own id. */
export async function contentHash(record: Record<string, unknown>): Promise<string> {
  const rest = { ...record };
  delete rest['id'];
  return sha256Hex(canonicalJson(rest));
}

/** The id a record must carry: 32 hex characters of its content hash. */
export async function deriveEventId(record: Record<string, unknown>): Promise<string> {
  return (await contentHash(record)).slice(0, 32);
}

export async function withEventId<T extends Record<string, unknown>>(record: T): Promise<T & { id: string }> {
  return { ...record, id: await deriveEventId(record) };
}

/**
 * Alias for a raw provider account identifier, identical on every device so one account never splits into two.
 * Only the alias is synced, and it travels inside the end-to-end encrypted payload; the raw value stays local.
 */
export async function deriveAccountAlias(provider: string, rawAccountId: string): Promise<string> {
  return `acct-${(await sha256Hex(`alias|${provider}|${rawAccountId.trim().toLowerCase()}`)).slice(0, 12)}`;
}
