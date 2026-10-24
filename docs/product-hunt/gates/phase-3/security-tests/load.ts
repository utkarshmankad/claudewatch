// Load test of the sync service with autocannon (external tool, not a repo dependency).
// Usage: TOOLS_DIR=/path/with/node_modules REPO_ROOT=$PWD npx tsx load.ts   (writes JSON to stdout)
// Local single-process, in-memory store: this measures this code on this machine, NOT the production deployment.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { api, load, newAccount } from './common.js';
import type { Account, Crypto } from './common.js';

const toolRequire = createRequire(`${process.env['TOOLS_DIR'] ?? process.cwd()}/x.js`);
const autocannon: any = toolRequire('autocannon'); // eslint-disable-line @typescript-eslint/no-explicit-any
const PORT = Number(process.env['LOAD_PORT'] ?? 8792);
const BASE = `http://127.0.0.1:${PORT}`;
const DURATION = Number(process.env['LOAD_SECONDS'] ?? 15);
const c = await load<Crypto>('src/sync/e2ee/crypto.ts');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startServer(limits: 'default' | 'raised'): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, ['--import', 'tsx', `${process.env['LOAD_SERVER'] ?? 'loadServer.ts'}`], { env: { ...process.env, LOAD_LIMITS: limits, LOAD_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => { child.stdout!.on('data', (d: Buffer) => { if (String(d).includes('load server')) resolve(); }); child.on('exit', () => reject(new Error('server exited'))); setTimeout(() => reject(new Error('server start timeout')), 20000); });
  return async () => { child.kill('SIGTERM'); await sleep(300); };
}
const stats = async (): Promise<Record<string, number>> => (await api(BASE, 'GET', '/__stats', { noIp: true })).json as Record<string, number>;

interface Run { scenario: string; connections: number; seconds: number; rps: number; p50ms: number; p99ms: number; maxMs: number; total: number; non2xx: number; statuses: Record<string, number>; errors: number; timeouts: number; note?: string }
const runs: Run[] = [];
const run = async (scenario: string, connections: number, requests: any[], note?: string): Promise<Run> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await autocannon({ url: BASE, connections, duration: DURATION, requests, timeout: 10 });
  const out: Run = { scenario, connections, seconds: DURATION, rps: Math.round(r.requests.average), p50ms: r.latency.p50, p99ms: r.latency.p99, maxMs: r.latency.max, total: r.requests.total, non2xx: r.non2xx, statuses: { ...(r['statusCodeStats'] ? Object.fromEntries(Object.entries(r['statusCodeStats']).map(([k, v]: [string, any]) => [k, v.count])) : {}) }, errors: r.errors, timeouts: r.timeouts, ...(note ? { note } : {}) };
  runs.push(out);
  return out;
};
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;
const ct = 'A'.repeat(1400); // about 1 KiB of ciphertext once base64 is counted

async function accounts(n: number): Promise<Account[]> {
  const out: Account[] = [];
  for (let i = 0; i < n; i += 1) out.push(await newAccount(BASE, c));
  return out;
}
async function seed(a: Account, objects: number): Promise<void> {
  for (let i = 0; i < objects; i += 1) await api(BASE, 'PUT', '/v1/objects', { token: a.token, body: { objectId: `seed-${i}`, epoch: 1, schemaVersion: 1, nonce: 'bm9uY2U', ciphertext: ct } });
}

const before = { cpus: os.cpus().length, model: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 1073741824), node: process.version };
const memory: Array<Record<string, number>> = [];

// 1. shipped limits: one device hammering an authenticated route
{
  const stop = await startServer('default');
  const [a] = await accounts(1);
  await run('L1 shipped limits: 1 device, GET /v1/objects, 50 connections', 50, [{ method: 'GET', path: '/v1/objects?after=0&limit=100', headers: { authorization: `Bearer ${a!.token}` } }], 'expected: about 60 requests accepted per minute for the device, the rest 429');
  memory.push({ phase: 1, ...(await stats()) });
  await stop();
}

// 2. capacity with limits raised
{
  const stop = await startServer('raised');
  const accts = await accounts(20);
  for (const a of accts.slice(0, 5)) await seed(a, 500);
  const seeded = accts.slice(0, 5);
  await run('L2a read: GET /v1/objects?limit=100 (500 stored objects, 5 accounts), 50 connections', 50,
    [{ method: 'GET', path: '/v1/objects?after=0&limit=100', setupRequest: (req: any) => { req.headers = { ...req.headers, authorization: `Bearer ${pick(seeded).token}` }; return req; } }]);
  memory.push({ phase: 2, ...(await stats()) });
  let n = 0;
  await run('L2b write: PUT /v1/objects, unique ids, 1 KiB ciphertext, 20 accounts, 50 connections', 50,
    [{ method: 'PUT', path: '/v1/objects', setupRequest: (req: any) => { req.headers = { ...req.headers, authorization: `Bearer ${pick(accts).token}`, 'content-type': 'application/json' }; req.body = JSON.stringify({ objectId: `w-${n++}-${Math.random()}`, epoch: 1, schemaVersion: 1, nonce: 'bm9uY2U', ciphertext: ct }); return req; } }]);
  memory.push({ phase: 3, ...(await stats()) });
  // session creation: ECDSA verify per request. Signed bodies are precomputed (a nonce can be used once).
  const pool: string[] = [];
  const t0 = Date.now();
  for (let i = 0; i < 40000; i += 1) {
    const a = accts[i % accts.length]!;
    const nonce = c.randomId();
    pool.push(JSON.stringify({ accountId: a.accountId, deviceId: a.deviceId, timestamp: Date.now(), nonce, signature: await c.sign(a.keys.signPrivateJwk, `session|${a.accountId}|${a.deviceId}|${Date.now()}|${nonce}`) }));
    if (i === 0) void t0;
  }
  // timestamps differ between body and signature above only if the clock ticked; re-sign deterministically instead
  pool.length = 0;
  for (let i = 0; i < 40000; i += 1) {
    const a = accts[i % accts.length]!; const nonce = c.randomId(); const ts = Date.now();
    pool.push(JSON.stringify({ accountId: a.accountId, deviceId: a.deviceId, timestamp: ts, nonce, signature: await c.sign(a.keys.signPrivateJwk, `session|${a.accountId}|${a.deviceId}|${ts}|${nonce}`) }));
  }
  let k = 0;
  await run('L2c session: POST /v1/session with valid ECDSA signature (distinct client IPs), 20 connections', 20,
    [{ method: 'POST', path: '/v1/session', setupRequest: (req: any) => { req.headers = { ...req.headers, 'content-type': 'application/json', 'cf-connecting-ip': `10.${(k >> 16) & 255}.${(k >> 8) & 255}.${k & 255}` }; req.body = pool[k++ % pool.length]; return req; } }],
    `${pool.length} pre-signed requests; a nonce is single use so later requests count as replays once the pool wraps`);
  memory.push({ phase: 4, ...(await stats()) });
  // unauthenticated junk: cost of rejecting
  let j = 0;
  await run('L2d reject path: unauthenticated GET /v1/devices, 50 connections', 50, [{ method: 'GET', path: '/v1/devices', setupRequest: (req: any) => { req.headers = { ...req.headers, 'cf-connecting-ip': `172.16.${(j >> 8) & 255}.${j++ & 255}` }; return req; } }]);
  memory.push({ phase: 5, ...(await stats()) });
  await stop();
}

// 3. soak: mixed traffic, memory sampled
{
  const stop = await startServer('raised');
  const accts = await accounts(20);
  await seed(accts[0]!, 200);
  let n = 0;
  const soakSeconds = Number(process.env['LOAD_SOAK_SECONDS'] ?? 60);
  const samples: Array<Record<string, number>> = [];
  const timer = setInterval(() => { void stats().then((s) => samples.push({ t: samples.length * 10, ...s })); }, 10_000);
  const t0 = Date.now();
  const r = await autocannon({ url: BASE, connections: 25, duration: soakSeconds, timeout: 10, requests: [
    { method: 'GET', path: '/v1/objects?after=0&limit=100', setupRequest: (q: any) => { q.headers = { ...q.headers, authorization: `Bearer ${accts[0]!.token}` }; return q; } },
    { method: 'GET', path: '/v1/objects?after=0&limit=100', setupRequest: (q: any) => { q.headers = { ...q.headers, authorization: `Bearer ${accts[0]!.token}` }; return q; } },
    { method: 'PUT', path: '/v1/objects', setupRequest: (q: any) => { q.headers = { ...q.headers, authorization: `Bearer ${pick(accts).token}`, 'content-type': 'application/json' }; q.body = JSON.stringify({ objectId: `s-${n++}-${Math.random()}`, epoch: 1, schemaVersion: 1, nonce: 'bm9uY2U', ciphertext: ct }); return q; } },
    { method: 'GET', path: '/v1/devices', setupRequest: (q: any) => { q.headers = { ...q.headers, authorization: `Bearer ${pick(accts).token}` }; return q; } },
  ] });
  clearInterval(timer);
  samples.push({ t: Math.round((Date.now() - t0) / 1000), ...(await stats()) });
  runs.push({ scenario: `L3 soak: mixed (2 read : 1 write : 1 list), 25 connections, ${soakSeconds}s`, connections: 25, seconds: soakSeconds, rps: Math.round(r.requests.average), p50ms: r.latency.p50, p99ms: r.latency.p99, maxMs: r.latency.max, total: r.requests.total, non2xx: r.non2xx, statuses: Object.fromEntries(Object.entries(r['statusCodeStats'] ?? {}).map(([k, v]: [string, any]) => [k, v.count])), errors: r.errors, timeouts: r.timeouts });
  memory.push(...samples.map((s) => ({ phase: 6, ...s })));
  await stop();
}

console.log(JSON.stringify({ machine: before, durationPerScenarioSeconds: DURATION, runs, memory }, null, 2));
