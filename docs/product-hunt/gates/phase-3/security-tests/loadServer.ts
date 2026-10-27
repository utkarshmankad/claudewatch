// HTTP wrapper around the sync service for load testing (same adapter as src/sync/service/devServer.ts) plus /__stats.
// LOAD_LIMITS=default keeps the shipped limits; LOAD_LIMITS=raised lifts per-device and per-account limits to measure capacity.
import { createServer } from 'node:http';
import { load } from './common.js';

const handler = await load<any>('src/sync/service/handler.ts'); // eslint-disable-line @typescript-eslint/no-explicit-any
const port = Number(process.env['LOAD_PORT'] ?? 8792);
const raised = process.env['LOAD_LIMITS'] === 'raised';
const sessionTtlMs = Number(process.env['LOAD_SESSION_TTL_MIN'] ?? 15) * 60_000; // a long scan needs a token that outlives the default 15 minutes
const service = handler.createSyncService({ config: { sessionTtlMs, ...(raised ? { requestsPerMinute: 1e9, maxAccountBytes: 2 ** 31, notifyPerHour: 1e9, enrollmentsPerHour: 1e9, joinAttemptsPerHour: 1e9, accountsPerHourPerIp: 1e9, sessionsPerMinutePerIp: 1e9 } : {}) } });

const byStatus: Record<string, number> = {};
let requests = 0;
const server = createServer((req, res) => {
  if (req.url === '/__stats') {
    const m = process.memoryUsage();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rssMB: Math.round(m.rss / 1048576), heapUsedMB: Math.round(m.heapUsed / 1048576), rateLimitEntries: service.rateLimitEntries(), accounts: service.store.accounts.size, auditEvents: service.store.audit.length, requests, byStatus }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const init: RequestInit = { method: req.method ?? 'GET', headers: req.headers as Record<string, string> };
    if (body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
    service.fetch(new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, init)).then(async (response: Response) => {
      requests += 1;
      byStatus[String(response.status)] = (byStatus[String(response.status)] ?? 0) + 1;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }).catch(() => { res.writeHead(500); res.end(); });
  });
});
setInterval(() => service.runRetention(), 60_000).unref();
server.listen(port, '127.0.0.1', () => console.log(`load server on ${port} limits=${raised ? 'raised' : 'default'}`));
