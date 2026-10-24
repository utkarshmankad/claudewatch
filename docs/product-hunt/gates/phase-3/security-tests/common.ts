// Shared helpers for the Phase 3 security tests. Run with the repo's tsx from the repo root:
//   REPO_ROOT=$PWD npx tsx <path>/pentest.ts
// fast-check and autocannon are NOT repo dependencies; install them in a scratch directory (see README.md).
import { pathToFileURL } from 'node:url';

export const REPO = process.env['REPO_ROOT'] ?? process.cwd();
export const load = <T>(rel: string): Promise<T> => import(pathToFileURL(`${REPO}/${rel}`).href) as Promise<T>;

export interface Crypto {
  generateDeviceKeys(): Promise<{ signPublic: string; encPublic: string; signPrivateJwk: unknown; encPrivateJwk: unknown }>;
  sign(jwk: unknown, message: string): Promise<string>;
  randomId(bytes?: number): string;
}

export interface Account { accountId: string; deviceId: string; token: string; keys: Awaited<ReturnType<Crypto['generateDeviceKeys']>> }

export async function api(base: string, method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string>; noIp?: boolean } = {}): Promise<{ status: number; json: Record<string, any> | null; headers: Headers; text: string }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  // Each call gets its own client address (as the Cloudflare header would) unless the test is about one client's bucket.
  if (!opts.noIp && !headers['cf-connecting-ip']) headers['cf-connecting-ip'] = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined || opts.raw !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.raw !== undefined ? { body: opts.raw } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try { json = JSON.parse(text) as Record<string, any>; } catch { json = null; }
  return { status: res.status, json, headers: res.headers, text };
}

export async function newAccount(base: string, c: Crypto, region = 'eu', headers: Record<string, string> = {}): Promise<Account> {
  const keys = await c.generateDeviceKeys();
  const created = await api(base, 'POST', '/v1/accounts', { body: { region, signPublic: keys.signPublic, encPublic: keys.encPublic }, headers });
  if (created.status !== 201 || !created.json) throw new Error(`account create failed: ${created.status}`);
  const accountId = created.json['accountId'] as string;
  const deviceId = created.json['deviceId'] as string;
  return { accountId, deviceId, keys, token: await session(base, c, { accountId, deviceId, keys }) };
}

export async function session(base: string, c: Crypto, a: { accountId: string; deviceId: string; keys: Account['keys'] }, timestamp = Date.now(), nonce = c.randomId(), headers: Record<string, string> = {}): Promise<string> {
  const signature = await c.sign(a.keys.signPrivateJwk, `session|${a.accountId}|${a.deviceId}|${timestamp}|${nonce}`);
  const res = await api(base, 'POST', '/v1/session', { body: { accountId: a.accountId, deviceId: a.deviceId, timestamp, nonce, signature }, headers });
  if (res.status !== 200 || !res.json) throw new Error(`session failed: ${res.status} ${res.text}`);
  return res.json['token'] as string;
}
