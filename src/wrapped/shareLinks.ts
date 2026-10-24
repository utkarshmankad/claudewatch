import { createHash, randomBytes } from 'node:crypto';
import { REFERRAL_RE } from './shareCards.js';

// Share instrumentation, referral codes and the public-link contract (Prompt 5.3, operation key 2026-10-10.1/prompt-5.3).
// Local only: no network code exists here. No hosting service exists yet, so a "link" is a local record that has an
// expiry and can be deleted; its url stays null until a service is built and approved. Rules: docs/SHARE_CARDS.md.

// --- instrumentation (log only) ---------------------------------------------------------------

export const SHARE_EVENTS = ['preview', 'export', 'export_refused', 'native_share', 'link_created', 'link_copied', 'link_deleted', 'referral_attributed'] as const;
export type ShareEvent = (typeof SHARE_EVENTS)[number];
/** Events a client may report through the daemon: the user's own share actions. Destinations are never reported or accepted. */
export const CLIENT_REPORTABLE_EVENTS: readonly ShareEvent[] = ['native_share', 'link_copied'];

export interface ShareLogContext { template?: string; fieldsOn?: number; fieldsTotal?: number; format?: string; error?: string; referral?: 'valid' | 'invalid' }

/** Builds a log line from an allow-listed set of keys; any other property on `ctx` is ignored. */
export function shareLogLine(event: ShareEvent, ctx: ShareLogContext = {}): string {
  const kv: Record<string, string | number> = { event };
  if (ctx.template && /^[a-z_]{1,32}$/.test(ctx.template)) kv['template'] = ctx.template;
  if (typeof ctx.fieldsOn === 'number' && typeof ctx.fieldsTotal === 'number') kv['fields'] = `${ctx.fieldsOn}/${ctx.fieldsTotal}`;
  if (ctx.format && /^[a-z]{1,8}$/.test(ctx.format)) kv['format'] = ctx.format;
  if (ctx.error && /^[a-z_]{1,40}$/.test(ctx.error)) kv['error'] = ctx.error;
  if (ctx.referral) kv['referral'] = ctx.referral;
  return `[share] ${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(' ')}`;
}

// --- referral ---------------------------------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

/** A random opaque code. It is not derived from any account, device or time, so it does not identify the sharer. */
export function newReferralCode(len = 10): string {
  const bytes = randomBytes(len);
  return [...bytes].map(b => ALPHABET[b % 32]).join('');
}

/** Records that a valid code was presented (for example at install). The code itself and any destination are never logged. */
export function attributeReferral(code: string, log: (line: string) => void = console.log): { valid: boolean } {
  const valid = REFERRAL_RE.test(code.toUpperCase());
  log(shareLogLine('referral_attributed', { referral: valid ? 'valid' : 'invalid' }));
  return { valid };
}

// --- public-link contract (local stub) --------------------------------------------------------

export const MIN_LINK_TTL_MS = 3_600_000; // 1 hour
export const MAX_LINK_TTL_MS = 30 * 86_400_000; // 30 days

export interface ShareLink { id: string; cardHash: string; createdAt: number; expiresAt: number; url: string | null }
export type LinkResult = { ok: true; link: ShareLink } | { ok: false; error: 'links_disabled' | 'expiry_required' | 'invalid_expiry' | 'preview_required' };

/**
 * Local stand-in for a hosting service. Off unless `enabled` is set by a separate, explicit user setting. A link needs a
 * reviewed card (its preview token) and an expiry, can be listed and deleted, and disappears when it expires. It holds a
 * hash of the card, never the card. `url` is null: no service is configured, and none is called.
 */
export class LocalShareLinkStore {
  private links = new Map<string, ShareLink>();
  constructor(private readonly opts: { enabled: boolean; now?: () => number; log?: (line: string) => void } = { enabled: false }) {}
  private now() { return (this.opts.now ?? Date.now)(); }
  private log(e: ShareEvent, c: ShareLogContext = {}) { (this.opts.log ?? console.log)(shareLogLine(e, c)); }

  create(input: { previewToken: string | undefined; ttlMs: number | undefined }): LinkResult {
    if (!this.opts.enabled) return { ok: false, error: 'links_disabled' };
    if (!input.previewToken) return { ok: false, error: 'preview_required' };
    if (input.ttlMs === undefined) return { ok: false, error: 'expiry_required' };
    if (!Number.isFinite(input.ttlMs) || input.ttlMs < MIN_LINK_TTL_MS || input.ttlMs > MAX_LINK_TTL_MS) return { ok: false, error: 'invalid_expiry' };
    const createdAt = this.now();
    const link: ShareLink = { id: randomBytes(12).toString('hex'), cardHash: createHash('sha256').update(input.previewToken).digest('hex'), createdAt, expiresAt: createdAt + input.ttlMs, url: null };
    this.links.set(link.id, link);
    this.log('link_created');
    return { ok: true, link };
  }

  list(): ShareLink[] { this.purge(); return [...this.links.values()]; }

  delete(id: string): boolean {
    this.purge();
    const had = this.links.delete(id);
    if (had) this.log('link_deleted');
    return had;
  }

  /** Removes expired links; returns how many. */
  purge(): number {
    let n = 0;
    for (const [id, l] of this.links) if (l.expiresAt <= this.now()) { this.links.delete(id); n++; }
    return n;
  }
}
