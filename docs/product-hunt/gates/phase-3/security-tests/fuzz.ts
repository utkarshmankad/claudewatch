// Property-based fuzzing of the Phase 3 sync code with fast-check (external tool, not a repo dependency).
// Usage: TOOLS_DIR=/path/with/node_modules REPO_ROOT=$PWD FUZZ_SEED=20261024 FUZZ_RUNS=2000 npx tsx fuzz.ts
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { load, REPO } from './common.js';

const toolRequire = createRequire(`${process.env['TOOLS_DIR'] ?? process.cwd()}/x.js`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc: any = toolRequire('fast-check');
const SEED = Number(process.env['FUZZ_SEED'] ?? 20261024);
const RUNS = Number(process.env['FUZZ_RUNS'] ?? 2000);
const HTTP_RUNS = Number(process.env['FUZZ_HTTP_RUNS'] ?? 20000);

/* eslint-disable @typescript-eslint/no-explicit-any */
const crypto = await load<any>('src/sync/e2ee/crypto.ts');
const allow = await load<any>('src/sync/e2ee/allowlist.ts');
const envelope = await load<any>('src/sync/e2ee/envelope.ts');
const push = await load<any>('src/sync/service/push.ts');
const handler = await load<any>('src/sync/service/handler.ts');
const clientMod = await load<any>('src/sync/client/client.ts');
const merge = await load<any>('src/sync/convergence/ledgerMerge.ts');
const render = await load<any>('src/companion/render.ts');

interface Outcome { id: string; target: string; runs: number; ok: boolean; seconds: number; counterexample?: string }
const outcomes: Outcome[] = [];

async function prop(id: string, target: string, runs: number, p: any): Promise<void> {
  const t0 = Date.now();
  const r = await fc.check(p, { numRuns: runs, seed: SEED, endOnFailure: true });
  outcomes.push({ id, target, runs: r.numRuns, ok: !r.failed, seconds: (Date.now() - t0) / 1000, ...(r.failed ? { counterexample: String(r.counterexample ? JSON.stringify(r.counterexample).slice(0, 600) : r.errorInstance?.message ?? r.error) } : {}) });
}

const pollutionClean = (): boolean => ({} as any).polluted === undefined && ({} as any).isAdmin === undefined;
const jsonish = fc.oneof(fc.string(), fc.integer(), fc.double({ noNaN: false }), fc.boolean(), fc.constant(null), fc.constant(undefined),
  fc.array(fc.string(), { maxLength: 5 }), fc.dictionary(fc.constantFrom('__proto__', 'constructor', 'prototype', 'a', 'polluted'), fc.anything(), { maxKeys: 3 }),
  fc.string({ minLength: 5000, maxLength: 6000 }), fc.constantFrom(-1, 0, 1, 2 ** 31, 2 ** 53, -(2 ** 53), 1e308, NaN, Infinity));

// ---- F1: the HTTP handler with an authenticated caller and a fake push sender ----
{
  const now = { t: 1_800_000_000_000 };
  const svc = handler.createSyncService({ now: () => now.t, pushSender: async () => ({ status: 201 }), config: { requestsPerMinute: 1e9, notifyPerHour: 1e9, pushPerDevicePerHour: 1e9, enrollmentsPerHour: 1e9, joinAttemptsPerHour: 1e9 } });
  const call = (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Response> =>
    svc.fetch(new Request(`https://sync.test${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined && method !== 'GET' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }));
  async function mk(): Promise<{ accountId: string; deviceId: string; token: string }> {
    const keys = await crypto.generateDeviceKeys();
    const created = (await (await call('POST', '/v1/accounts', { region: 'eu', signPublic: keys.signPublic, encPublic: keys.encPublic }, undefined, { 'cf-connecting-ip': `1.1.${Math.floor(Math.random() * 250)}.1` })).json()) as any;
    const nonce = crypto.randomId();
    const signature = await crypto.sign(keys.signPrivateJwk, `session|${created.accountId}|${created.deviceId}|${now.t}|${nonce}`);
    const s = (await (await call('POST', '/v1/session', { accountId: created.accountId, deviceId: created.deviceId, timestamp: now.t, nonce, signature })).json()) as any;
    return { accountId: created.accountId, deviceId: created.deviceId, token: s.token };
  }
  const me = await mk();
  const other = await mk();
  const routes: Array<[string, string]> = [
    ['POST', '/v1/accounts'], ['POST', '/v1/session'], ['POST', '/v1/enrollments/join'], ['POST', '/v1/enrollments/status'], ['POST', '/v1/enrollments'],
    ['POST', '/v1/enrollments/pending'], ['POST', '/v1/enrollments/approve'], ['GET', '/v1/devices'], ['DELETE', '/v1/devices/X'], ['POST', '/v1/devices/X/revoke'],
    ['POST', '/v1/epoch'], ['PUT', '/v1/keywraps'], ['GET', '/v1/keywraps'], ['PUT', '/v1/objects'], ['GET', '/v1/objects'], ['PUT', '/v1/push/subscription'],
    ['GET', '/v1/push/subscription'], ['POST', '/v1/push/renew'], ['DELETE', '/v1/push/subscription'], ['POST', '/v1/push/notify'], ['GET', '/v1/export'],
  ];
  const keys = ['region', 'signPublic', 'encPublic', 'accountId', 'deviceId', 'timestamp', 'nonce', 'signature', 'token', 'confirm', 'wrapped', 'newEpoch', 'epoch', 'objectId', 'schemaVersion', 'ciphertext', 'endpoint', 'p256dh', 'auth', 'quietHours', 'kinds', 'kind', 'dedupeKey', 'startMinute', 'endMinute', 'utcOffsetMinutes', 'ephemeralPublic'];
  const body = fc.oneof(
    fc.dictionary(fc.constantFrom(...keys), jsonish, { maxKeys: 12 }),
    fc.string({ maxLength: 200 }), // raw, mostly invalid JSON
    fc.constant({ wrapped: { ephemeralPublic: 'a', nonce: 'b', ciphertext: 'c' }, epoch: 1, token: 'x' }),
  );
  const pathTail = fc.constantFrom('', '?after=0', '?after=-5&limit=3', '?after=abc', '?limit=0', '?after=1e9&limit=1000000', '?after=%00');
  const caller = fc.constantFrom<'me' | 'other' | 'none'>('me', 'other', 'none');
  let created = 0;
  const hist: Record<string, number> = {};
  await prop('F1', 'HTTP handler (21 routes, authenticated and not, 20k requests): never 500, always JSON, never leaks stack text', HTTP_RUNS, fc.asyncProperty(fc.constantFrom(...routes), body, pathTail, caller, async (route: [string, string], b: unknown, tail: string, who: string) => {
    now.t += 1; // keep sessions alive and rate windows moving
    const token = who === 'me' ? me.token : who === 'other' ? other.token : undefined;
    const path = route[1] === '/v1/devices/X' || route[1] === '/v1/devices/X/revoke' ? route[1].replace('X', fc.sample(fc.constantFrom(me.deviceId, other.deviceId, 'nope'), 1)[0]) : route[1];
    const res = await call(route[0], route[0] === 'GET' ? path + tail : path, b, token, who === 'none' ? { 'cf-connecting-ip': `7.7.${(created++ % 250)}.${Math.floor(created / 250) % 250}` } : {});
    const text = await res.text();
    hist[String(res.status)] = (hist[String(res.status)] ?? 0) + 1;
    if (res.status === 500) return false;
    try { JSON.parse(text); } catch { return false; }
    if (/node_modules|\bat \S+ \(|\.ts:\d+/.test(text)) return false;
    // the shared accounts must survive deletion/revocation fuzz, otherwise later runs only hit 401s
    return pollutionClean();
  }));
  const alive = await call('GET', '/v1/devices', undefined, me.token);
  outcomes[outcomes.length - 1]!.target += ` (status mix ${JSON.stringify(hist)}; caller still authenticated afterwards: ${alive.status === 200})`;
}

// ---- F2: allow-list and envelope validators ----
{
  const onlyAllowList = (fn: () => unknown): boolean => {
    try { fn(); return true; } catch (e) { return e instanceof allow.AllowListError; }
  };
  const base = { kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718', observedAt: 1_700_000_000_000, source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: 5 }, id: 'abcdef012345678900000001' };
  const mutate = fc.tuple(fc.constantFrom(...Object.keys(base)), fc.anything()).map(([k, v]: [string, unknown]) => ({ ...base, [k]: v }));
  await prop('F2a', 'validateLedgerRecord: arbitrary and mutated records only ever return or throw AllowListError', RUNS, fc.property(fc.oneof(fc.anything(), mutate), (x: unknown) => onlyAllowList(() => allow.validateLedgerRecord(x)) && pollutionClean()));
  await prop('F2b', 'validatePrefs / validateDeviceEntry: same', RUNS, fc.property(fc.anything(), (x: unknown) => onlyAllowList(() => allow.validatePrefs(x)) && onlyAllowList(() => allow.validateDeviceEntry(x)) && pollutionClean()));
  await prop('F2c', 'validateEnvelope: arbitrary envelopes only return or throw AllowListError; accepted records have no extra keys', RUNS,
    fc.property(fc.oneof(fc.anything(), fc.record({ v: fc.constant(1), epoch: fc.integer(), sender: fc.string(), deviceSeq: fc.integer(), prev_hash: fc.string(), kind: fc.constantFrom('ledger_batch', 'prefs', 'devices'), items: fc.array(fc.anything(), { maxLength: 3 }) })), (x: unknown) => {
      try { const e = envelope.validateEnvelope(x); return Array.isArray(e.items) && pollutionClean(); } catch (err) { return err instanceof allow.AllowListError; }
    }));
  const labelAttack = fc.string().map((s: string) => `${s}`).filter((s: string) => s.length > 0 && s.length <= 40);
  await prop('F2d', 'checkLabel never accepts URLs, e-mail, credentials, IPv4 or control characters', RUNS * 5, fc.property(fc.oneof(labelAttack, fc.constantFrom('a://b', 'x@y', 'Bearer abc', 'sk-ant-xxxxxxxxxxxx', '10.0.0.1', 'a\nb', 'cookie')), (s: string) => {
    try { allow.checkLabel(s, 'p', 40); } catch { return true; }
    return !/:\/\/|@|bearer\s|sk-ant-|cookie|authorization|[\r\n\t]|\b(?:\d{1,3}\.){3}\d{1,3}\b/i.test(s);
  }));
}

// ---- F3: cryptography ----
{
  const bytes = fc.uint8Array({ minLength: 0, maxLength: 3000 });
  const binding = { accountId: 'acct', objectId: 'obj', epoch: 1, schemaVersion: 1 };
  const key = crypto.generateAccountKey();
  await prop('F3a', 'seal/open round trip for arbitrary JSON values', RUNS, fc.asyncProperty(fc.jsonValue(), async (v: unknown) => {
    const sealed = await crypto.seal(key, binding, v);
    return JSON.stringify(await crypto.open(key, binding, sealed)) === JSON.stringify(v);
  }));
  await prop('F3b', 'any mutated ciphertext/nonce, or different AAD binding or key, fails to open', RUNS, fc.asyncProperty(fc.jsonValue(), fc.nat(), fc.integer({ min: 1, max: 255 }), fc.constantFrom('ct', 'nonce', 'acct', 'obj', 'epoch', 'schema', 'key'), async (v: unknown, pos: number, flip: number, what: string) => {
    const sealed = await crypto.seal(key, binding, v);
    let b = { ...binding }; let s = { ...sealed }; let k = key;
    const mutateB64 = (str: string): string => { const raw = Buffer.from(str, 'base64'); raw[pos % raw.length] = raw[pos % raw.length]! ^ flip; return raw.toString('base64'); };
    if (what === 'ct') s.ciphertext = mutateB64(s.ciphertext);
    if (what === 'nonce') s.nonce = mutateB64(s.nonce);
    if (what === 'acct') b = { ...b, accountId: 'acct2' };
    if (what === 'obj') b = { ...b, objectId: 'obj2' };
    if (what === 'epoch') b = { ...b, epoch: 2 };
    if (what === 'schema') b = { ...b, schemaVersion: 2 };
    if (what === 'key') k = crypto.generateAccountKey();
    try { await crypto.open(k, b, s); return false; } catch { return true; }
  }));
  await prop('F3c', 'unpad never reads out of bounds on arbitrary bytes (throws or returns a slice)', RUNS * 3, fc.property(bytes, (b: Uint8Array) => { try { const out = crypto.unpad(b); return out.length <= b.length; } catch { return true; } }));
  await prop('F3d', 'verify() returns false (never throws) for arbitrary key/message/signature', RUNS, fc.asyncProperty(fc.string(), fc.string(), fc.string(), async (a: string, m: string, s: string) => (await crypto.verify(a, m, s)) === false));
  await prop('F3e', 'decryptBackup rejects arbitrary blobs without hanging', 300, fc.asyncProperty(fc.record({ v: fc.constantFrom(1, 2), kdf: fc.constantFrom('PBKDF2-SHA256', 'x'), iterations: fc.constantFrom(1, 99_999, 100_000), salt: fc.string(), nonce: fc.string(), ciphertext: fc.string() }), fc.string(), async (blob: unknown, pass: string) => { try { await crypto.decryptBackup(blob, pass); return false; } catch { return true; } }));
  await prop('F3f', 'wrapAccountKey/unwrapAccountKey round trip; any other binding or key fails', 300, fc.asyncProperty(fc.string(), fc.string(), async (b1: string, b2: string) => {
    const dev = await crypto.generateDeviceKeys(); const other = await crypto.generateDeviceKeys();
    const ak = crypto.generateAccountKey();
    const w = await crypto.wrapAccountKey(ak, dev.encPublic, b1);
    const ok = Buffer.from(await crypto.unwrapAccountKey(w, dev.encPrivateJwk, b1)).equals(Buffer.from(ak));
    let wrongKey = false; try { await crypto.unwrapAccountKey(w, other.encPrivateJwk, b1); } catch { wrongKey = true; }
    let wrongBinding = b1 === b2; if (!wrongBinding) { try { await crypto.unwrapAccountKey(w, dev.encPrivateJwk, b2); } catch { wrongBinding = true; } }
    return ok && wrongKey && wrongBinding;
  }));
  await prop('F3g', 'enrollmentTag: different secret or inputs give different tags', RUNS, fc.asyncProperty(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), fc.string(), fc.string(), async (s1: string, s2: string, a: string, b: string) => {
    const t1 = await crypto.enrollmentTag(s1, 'join', a, b);
    return s1 === s2 || t1 !== (await crypto.enrollmentTag(s2, 'join', a, b));
  }));
}

// ---- F4: push validators ----
{
  const only = (fn: () => unknown): boolean => { try { fn(); return true; } catch (e) { return e instanceof push.PushValidationError; } };
  const hosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '*.notify.windows.com'];
  const hostile = fc.tuple(fc.constantFrom('https', 'http', 'ftp', ''), fc.constantFrom(...hosts, 'localhost', '127.0.0.1', '[::1]', '0x7f.1', '2130706433', 'evil.test'), fc.constantFrom('', '.evil.test', 'x', '@evil.test', '%2eevil.test', ':8443', '\\@evil.test', '。evil。test', '.'), fc.string({ maxLength: 12 }), fc.constantFrom('', 'user:pw@', 'a@', 'x:y@'))
    .map(([scheme, host, suffix, path, userinfo]: string[]) => `${scheme}://${userinfo}${host}${suffix}/${path}`);
  await prop('F4a', 'validatePushEndpoint: anything accepted is https, no credentials/port, and its parsed host is an allowed push host or subdomain', RUNS * 5, fc.property(fc.oneof(fc.string(), hostile, fc.webUrl()), (u: string) => {
    let out: string; try { out = push.validatePushEndpoint(u); } catch (e) { return e instanceof push.PushValidationError; }
    const url = new URL(out);
    const h = url.hostname;
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' && hosts.some((s) => (s.startsWith('*.') ? h.endsWith(s.slice(1)) && h.length > s.length - 1 : h === s)) && !/^[\d.]+$/.test(h);
  }));
  await prop('F4b', 'validatePushKeys / QuietHours / Kinds only throw PushValidationError; inQuietHours total over all numbers', RUNS * 2, fc.property(fc.anything(), fc.anything(), fc.double(), (a: unknown, b: unknown, t: number) => only(() => push.validatePushKeys(a, b)) && only(() => push.validateQuietHours(a)) && only(() => push.validateKinds(b)) && typeof push.inQuietHours(t, { startMinute: 0, endMinute: 100, utcOffsetMinutes: 0 }) === 'boolean'));
}

// ---- F5: the client against a hostile service (after an honest enrollment) ----
{
  const known = (e: any): boolean => e instanceof clientMod.SyncUnavailableError || e instanceof clientMod.DeviceRevokedError || e instanceof clientMod.AccountDeletedError || e instanceof clientMod.KeyMissingError || e instanceof clientMod.SyncDisabledError || (e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError));
  const bad = fc.oneof(jsonish, fc.dictionary(fc.constantFrom('head', 'epoch', 'objects', 'wraps', 'devices', 'seq', 'objectId', 'ciphertext', 'nonce', 'schemaVersion', 'token', 'expiresAt'), jsonish, { maxKeys: 6 }),
    fc.record({ head: jsonish, epoch: jsonish, objects: fc.array(fc.dictionary(fc.constantFrom('seq', 'objectId', 'epoch', 'schemaVersion', 'nonce', 'ciphertext'), jsonish, { maxKeys: 6 }), { maxLength: 3 }) }),
    fc.record({ wraps: fc.array(fc.dictionary(fc.constantFrom('epoch', 'wrapped'), jsonish, { maxKeys: 2 }), { maxLength: 3 }) }));
  const crashes: string[] = [];
  await prop('F5', 'SyncClient.sync()/pull() against arbitrary server replies: no TypeError/RangeError, state stays loadable and JSON-serialisable', Number(process.env['FUZZ_CLIENT_RUNS'] ?? 1500), fc.asyncProperty(bad, fc.constantFrom('/v1/objects', '/v1/keywraps', '/v1/devices', '/v1/session'), fc.constantFrom(200, 200, 500, 429, 410, 401), async (reply: unknown, target: string, status: number) => {
    const clock = { t: 1_800_000_000_000 };
    const svc = handler.createSyncService({ now: () => clock.t });
    let hostile = false;
    const transport = async (url: string, init: any): Promise<Response> => {
      const path = new URL(url).pathname;
      if (hostile && path === target) return new Response(JSON.stringify(reply ?? null), { status });
      return svc.fetch(new Request(url, init));
    };
    const storage = new clientMod.MemoryStorage();
    const deps = { storage, transport, now: () => clock.t, sleep: async () => undefined, retryDelaysMs: [] };
    const a = await clientMod.SyncClient.enable(deps, { baseUrl: 'https://sync.test', region: 'eu' });
    await a.queueLedger([{ kind: 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718', observedAt: 1_700_000_000_000, source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: 5 } }]);
    hostile = true;
    for (const op of [() => a.sync(), () => a.pull(), () => a.listDevices(), () => a.rotateKey()]) {
      try { await op(); } catch (e) { if (!known(e)) { crashes.push(`${(e as Error).constructor.name}: ${(e as Error).message}`); return false; } }
    }
    hostile = false;
    try { JSON.stringify(await storage.get()); await clientMod.SyncClient.load({ ...deps, transport: transport }); } catch { return false; }
    return true;
  }));
  if (crashes.length) outcomes[outcomes.length - 1]!.target += ` | first crash: ${crashes[0]}`;
}

// ---- F6: ledger merge convergence ----
{
  const ids = ['aaaaaaaaaaaaaaaa0001', 'aaaaaaaaaaaaaaaa0002', 'aaaaaaaaaaaaaaaa0003', 'aaaaaaaaaaaaaaaa0004'];
  const rec = fc.record({ id: fc.constantFrom(...ids), observedAt: fc.integer({ min: 1_700_000_000_000, max: 1_700_000_900_000 }), pct: fc.integer({ min: 0, max: 100 }), sup: fc.option(fc.constantFrom(...ids), { nil: undefined }) })
    .map((r: any) => ({ kind: r.sup ? 'correction' : 'provider_snapshot', provider: 'claude', accountAlias: 'work', devicePseudonym: 'a1b2c3d4e5f60718', observedAt: r.observedAt, source: 'web', confidence: 'high', measurementMethod: 'provider_reported', measures: { quotaPercentUsed: r.pct }, id: r.id, ...(r.sup && r.sup !== r.id ? { supersedes: r.sup, correctionReason: 'provider_restated' } : {}) }));
  await prop('F6', 'ledger merge: applying the same records in any order (and twice) gives the same effective ledger', 1500, fc.asyncProperty(fc.array(rec, { minLength: 1, maxLength: 8 }), fc.integer(), async (records: any[], seed: number) => {
    let valid: any[]; try { valid = records.map((r) => allow.validateLedgerRecord(r)); } catch { return true; }
    const run = async (order: any[]): Promise<string> => { const s = merge.emptyLedger(); for (const r of order) await merge.mergeRecord(s, r); return JSON.stringify(merge.effectiveRecords(s).map((r: any) => r.id + ':' + JSON.stringify(r.measures)).sort()); };
    const shuffled = [...valid].sort((a, b) => ((a.id.charCodeAt(19) * 31 + seed) % 7) - ((b.id.charCodeAt(19) * 31 + seed) % 7)).reverse();
    return (await run(valid)) === (await run(shuffled)) && (await run(valid)) === (await run([...valid, ...valid]));
  }));
}

// ---- F7: companion renderer and service worker ----
{
  const allowedTags = new Set(['section', 'h2', 'p', 'ul', 'li', 'span', 'div']);
  const walk = (n: any): boolean => allowedTags.has(n.tag) && (n.text === undefined || typeof n.text === 'string') && Object.keys(n.attrs ?? {}).every((k) => ['class', 'role', 'id', 'aria-labelledby'].includes(k)) && (n.children ?? []).every(walk);
  const q = fc.record({ provider: fc.string(), accountAlias: fc.string(), window: fc.string(), usedPercent: fc.option(fc.double(), { nil: null }), resetAt: fc.option(fc.integer(), { nil: null }), risk: fc.string(), state: fc.string() });
  await prop('F7a', 'renderView: arbitrary view contents produce only allowed tags/attributes and string text (no markup passes through)', RUNS, fc.property(fc.record({
    sync: fc.record({ freshness: fc.string(), lastSyncAt: fc.option(fc.integer({ min: 0, max: 8.64e15 }), { nil: null }) }), quotas: fc.array(q, { maxLength: 4 }),
    recommendation: fc.option(fc.record({ summary: fc.string() }), { nil: null }), devices: fc.array(fc.record({ name: fc.string(), current: fc.boolean(), health: fc.string(), lastSeenAt: fc.integer({ min: 0, max: 8.64e15 }) }), { maxLength: 3 }),
    notifications: fc.record({ alertFrequency: fc.string(), quietHours: fc.option(fc.record({ startMinute: fc.integer(), endMinute: fc.integer() }), { nil: null }), mutedProviders: fc.array(fc.string(), { maxLength: 3 }) }),
  }), (view: any) => { try { return render.renderView(view).every(walk); } catch { return false; } }));

  const swSource = readFileSync(`${REPO}/companion/sw.js`, 'utf8');
  const shown: Array<{ title: string; body: string }> = [];
  const listeners: Record<string, (e: any) => void> = {};
  const sandbox: any = { self: { addEventListener: (t: string, f: any) => { listeners[t] = f; }, registration: { showNotification: (title: string, o: any) => { shown.push({ title, body: o.body }); return Promise.resolve(); } }, location: { origin: 'https://c.test' }, clients: { matchAll: async () => [], claim: async () => undefined } }, caches: { open: async () => ({ addAll: async () => undefined }), keys: async () => [], match: async () => undefined }, URL, JSON, Object, fetch: async () => new Response('') };
  vm.runInNewContext(swSource, sandbox);
  const allowedTitles = new Set(['ClaudeWatch: quota risk', 'ClaudeWatch: quota reset']);
  await prop('F7b', 'service worker push handler: any payload (JSON, __proto__, garbage) shows only one of the two fixed notifications', RUNS * 3, fc.property(fc.oneof(fc.string(), fc.jsonValue().map((j: unknown) => JSON.stringify(j)), fc.constantFrom('{"v":1,"k":"__proto__"}', '{"v":1,"k":"constructor"}', '{"__proto__":{"k":"x"},"v":1}', '{"v":1,"k":"<img src=x onerror=alert(1)>"}', '')), (payload: string) => {
    shown.length = 0;
    listeners['push']!({ data: { text: () => payload }, waitUntil: () => undefined });
    return shown.length === 1 && allowedTitles.has(shown[0]!.title) && !/[<>]/.test(shown[0]!.body);
  }));
}

const failed = outcomes.filter((o) => !o.ok);
console.log(JSON.stringify({ seed: SEED, runsPerProperty: RUNS, httpRuns: HTTP_RUNS, total: outcomes.length, failed: failed.length, outcomes }, null, 2));
process.exit(failed.length ? 1 : 0);
