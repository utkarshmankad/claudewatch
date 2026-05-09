import { createServer, type Server } from 'http';
import express from 'express';
import cors from 'cors';
import { getAlertHistory, getDailyTokensByModel, getLatestSnapshot, getDb, getSessionTokens, insertSessionTokens, getWeeklyTokens } from '../store/db.js';
import { getTotalCostSince } from '../store/usage.js';
import { currentBillingPeriod } from '../api/usageClient.js';
import { getCostCache } from './costCache.js';
import { generateDashboardHTML } from '../web/template.js';
import type { Config } from '../config/schema.js';

export const WEB_PORT = 7734;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapSnapshot(snap: ReturnType<typeof getLatestSnapshot>) {
  if (!snap) return null;
  return {
    polledAt:         snap.recordedAt,
    model:            snap.model,
    inputTokens:      snap.uncachedInputTokens,
    cacheReadTokens:  snap.cacheReadTokens,
    cacheWriteTokens: snap.cacheWrite1hTokens + snap.cacheWrite5mTokens,
    outputTokens:     snap.outputTokens,
    estimatedCostUsd: 0,
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function startWebServer(config: Config): Server {
  const app = express();

  app.use(cors({
    // Allow localhost dev servers and Chrome extension pages
    origin: (origin, cb) => {
      if (!origin ||
          /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
          /^chrome-extension:\/\//.test(origin)) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
  }));
  app.use(express.json());

  // ---------------------------------------------------------------------------
  // POST /api/session — extension pushes live claude.ai session data
  // ---------------------------------------------------------------------------
  app.post('/api/session', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      insertSessionTokens({
        tokensUsed: typeof body['tokensUsed'] === 'number' ? body['tokensUsed'] : null,
        tokenLimit: typeof body['tokenLimit'] === 'number' ? body['tokenLimit'] : null,
        plan:       typeof body['plan']       === 'string' ? body['plan']       : null,
        resetsAt:   typeof body['resetsAt']   === 'string' ? body['resetsAt']   : null,
        capturedAt: typeof body['capturedAt'] === 'string' ? body['capturedAt'] : undefined,
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[/api/session] error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/status
  // ---------------------------------------------------------------------------
  app.get('/api/status', (_req, res) => {
    const costs = getCostCache();
    const period = currentBillingPeriod();

    // Raw DB query — more resilient than getLatestSnapshot() if the ORM layer
    // has a mapping bug; also surfaces the exact column names for debugging.
    interface RawSnapRow {
      recorded_at: string | null;
      model: string | null;
      uncached_input_tokens: number;
      input_tokens?: number;
      cache_read_tokens: number;
      cache_write_1h_tokens: number;
      cache_write_5m_tokens: number;
      output_tokens: number;
      estimated_cost_usd?: number;
    }
    const raw = getDb().prepare(
      'SELECT * FROM usage_snapshots ORDER BY rowid DESC LIMIT 1'
    ).get() as RawSnapRow | undefined;
    console.log('[api/status] raw row:', JSON.stringify(raw));
    console.log('[api/status] costCache:', JSON.stringify(costs));

    const snapshot = raw ? {
      polledAt:         raw.recorded_at                                                       ?? null,
      model:            raw.model                                                             ?? null,
      inputTokens:      raw.uncached_input_tokens ?? raw.input_tokens                         ?? 0,
      cacheReadTokens:  raw.cache_read_tokens                                                 ?? 0,
      cacheWriteTokens: (raw.cache_write_1h_tokens ?? 0) + (raw.cache_write_5m_tokens ?? 0),
      outputTokens:     raw.output_tokens                                                     ?? 0,
      estimatedCostUsd: raw.estimated_cost_usd                                                ?? 0,
    } : null;

    // Fall back to DB aggregation if the in-process cache is empty (e.g. fresh
    // daemon start before the first poll completes).
    let monthly   = costs?.monthly   ?? null;
    let weekly    = costs?.weekly    ?? null;
    let daily     = costs?.daily     ?? null;
    if (costs === null) {
      const now = new Date();
      const dayStart  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
      const weekStart = new Date(now);
      weekStart.setUTCDate(weekStart.getUTCDate() - 7);
      weekStart.setUTCHours(0, 0, 0, 0);
      monthly = getTotalCostSince(period.startingAt);
      weekly  = getTotalCostSince(weekStart.toISOString());
      daily   = getTotalCostSince(dayStart);
    }

    // Session data pushed by the extension
    const sessionRow = getSessionTokens();

    // Weekly token count (rolling 7-day window from usage_snapshots)
    const weeklyTokensUsed = getWeeklyTokens();
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysSinceMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMon,
    ));
    const weekReset = new Date(weekStart);
    weekReset.setUTCDate(weekReset.getUTCDate() + 7);

    res.json({
      billingPeriod: {
        startingAt: costs?.billingPeriodStart ?? period.startingAt,
        endingAt:   costs?.billingPeriodEnd   ?? period.endingAt,
      },
      costs: {
        monthly,
        weekly,
        daily,
        updatedAt: costs?.updatedAt ?? null,
      },
      spendLimitUsd:       config.spendLimitUSD,
      weeklySpendLimitUsd: config.weeklySpendLimitUsd ?? null,
      weeklyTokenLimit:    config.weeklyTokenLimit ?? null,
      pollIntervalMinutes: config.pollIntervalMinutes ?? 5,
      lastPollAt:          snapshot?.polledAt ?? null,
      snapshot,
      version: '0.1.0',
      session: sessionRow ? {
        tokensUsed: sessionRow.tokensUsed,
        tokenLimit: sessionRow.tokenLimit,
        plan:       sessionRow.plan,
        resetsAt:   sessionRow.resetsAt,
        windowEnd:  sessionRow.resetsAt,
        pct: sessionRow.tokenLimit && sessionRow.tokenLimit > 0 && sessionRow.tokensUsed != null
          ? (sessionRow.tokensUsed / sessionRow.tokenLimit) * 100
          : 0,
      } : null,
      weekly: {
        tokensUsed: weeklyTokensUsed,
        weekStart:  weekStart.toISOString(),
        weekReset:  weekReset.toISOString(),
        resetsAt:   weekReset.toISOString(),
      },
      config: {
        weeklyTokenLimit: config.weeklyTokenLimit ?? null,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/usage?days=30
  // ---------------------------------------------------------------------------
  app.get('/api/usage', (req, res) => {
    const days = Math.min(90, Math.max(1, parseInt(String(req.query['days'] ?? '30'), 10) || 30));
    const rows = getDailyTokensByModel(days);
    res.json({ rows });
  });

  // ---------------------------------------------------------------------------
  // GET /api/alerts?limit=50
  // ---------------------------------------------------------------------------
  app.get('/api/alerts', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50));
    const alerts = getAlertHistory(limit);
    res.json({ alerts });
  });

  // ---------------------------------------------------------------------------
  // GET / — inline dashboard (no filesystem dependency)
  // ---------------------------------------------------------------------------
  app.get('/', (_req, res) => {
    const costs = getCostCache();
    const snapshot = getLatestSnapshot();
    const alerts = getAlertHistory(20);
    const period = currentBillingPeriod();

    const dashSnap = mapSnapshot(snapshot);
    const html = generateDashboardHTML({
      costs: {
        monthly:   costs?.monthly   ?? null,
        weekly:    costs?.weekly    ?? null,
        daily:     costs?.daily     ?? null,
        updatedAt: costs?.updatedAt ?? null,
      },
      billingPeriod: {
        startingAt: costs?.billingPeriodStart ?? period.startingAt,
        endingAt:   costs?.billingPeriodEnd   ?? period.endingAt,
      },
      spendLimitUsd:       config.spendLimitUSD,
      weeklySpendLimitUsd: config.weeklySpendLimitUsd ?? null,
      weeklyTokenLimit:    config.weeklyTokenLimit ?? null,
      pollIntervalMinutes: config.pollIntervalMinutes,
      lastPollAt:          dashSnap?.polledAt ?? null,
      snapshot:            dashSnap,
      alerts,
    });

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  // ---------------------------------------------------------------------------
  // Start listening
  // ---------------------------------------------------------------------------
  const server = createServer(app);

  server.listen(WEB_PORT, '127.0.0.1', () => {
    console.log(`[ClaudeWatch] web dashboard → http://localhost:${WEB_PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[ClaudeWatch] port ${WEB_PORT} in use — web server not started`);
    } else {
      console.error('[ClaudeWatch] web server error:', err.message);
    }
  });

  return server;
}
