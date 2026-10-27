// Local development deployment: `npm run sync:dev` serves the sync API on 127.0.0.1 with in-memory storage.
// Data is lost on restart by design. Never expose this to a network.
import { createServer } from 'node:http';
import { createSyncService } from './handler.js';
import { createWebPushSender, vapidFromEnv } from './webpush.js';

const port = Number(process.env['SYNC_DEV_PORT'] ?? 8787);
// Push delivery is on only when the owner supplies VAPID_PRIVATE_JWK and VAPID_SUBJECT in the environment.
const vapid = vapidFromEnv();
const service = createSyncService(vapid ? { pushSender: createWebPushSender({ keys: vapid }) } : {});

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const init: RequestInit = { method: req.method ?? 'GET', headers: req.headers as Record<string, string> };
    if (body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
    service.fetch(new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, init)).then(async (response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
});

setInterval(() => service.runRetention(), 60 * 60 * 1000).unref();
server.listen(port, '127.0.0.1', () => {
  console.log(`claudewatch sync dev service on http://127.0.0.1:${port} (in-memory)`);
});
