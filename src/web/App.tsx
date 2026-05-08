import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import type { AlertsResponse, StatusResponse, UsageResponse } from './types.js';
import { CostGauge } from './components/CostGauge.js';
import { DailyChart } from './components/DailyChart.js';
import { AlertTable } from './components/AlertTable.js';
import { StatusBar } from './components/StatusBar.js';

const POLL_INTERVAL_MS = 30_000;
const USAGE_DAYS = 30;

// ---------------------------------------------------------------------------
// Polling hook
// ---------------------------------------------------------------------------

function useInterval(fn: () => void, delay: number) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; }, [fn]);
  useEffect(() => {
    const id = setInterval(() => ref.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

interface DashState {
  status:  StatusResponse  | null;
  usage:   UsageResponse   | null;
  alerts:  AlertsResponse  | null;
  error:   string          | null;
  lastUpdated: Date        | null;
}

const INIT: DashState = {
  status: null, usage: null, alerts: null, error: null, lastUpdated: null,
};

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export default function App() {
  const [state, setState] = useState<DashState>(INIT);

  const fetchAll = useCallback(async () => {
    try {
      const [status, usage, alerts] = await Promise.all([
        api.status(),
        api.usage(USAGE_DAYS),
        api.alerts(50),
      ]);
      setState({ status, usage, alerts, error: null, lastUpdated: new Date() });
    } catch (err) {
      setState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Unknown error',
        lastUpdated: new Date(),
      }));
    }
  }, []);

  // Initial fetch
  useEffect(() => { void fetchAll(); }, [fetchAll]);

  // Periodic polling
  useInterval(() => { void fetchAll(); }, POLL_INTERVAL_MS);

  const { status, usage, alerts, error, lastUpdated } = state;

  return (
    <div className="app-shell">

      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header className="topbar">
        <span className="topbar-logo">ClaudeWatch</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          Anthropic API usage &amp; spend
        </span>
        <StatusBar
          lastUpdated={lastUpdated}
          error={error}
          pollInterval={POLL_INTERVAL_MS / 1000}
        />
      </header>

      {/* ── Main content ────────────────────────────────────────────── */}
      <main className="main-content">

        {error && !status && (
          <div className="error-banner">
            <strong>Cannot reach daemon</strong> — {error}
            <br />
            <span style={{ fontSize: 12, opacity: .8 }}>
              Make sure the daemon is running: <code>claudewatch start</code>
            </span>
          </div>
        )}

        {/* Row 1: Gauge + last-poll metadata */}
        <div className="grid-1-2">
          <CostGauge
            status={status}
            costs={status?.costs ?? null}
          />
          <DailyChart
            rows={usage?.rows ?? []}
            days={USAGE_DAYS}
          />
        </div>

        {/* Row 2: Alert history */}
        <AlertTable alerts={alerts?.alerts ?? []} />

      </main>
    </div>
  );
}
