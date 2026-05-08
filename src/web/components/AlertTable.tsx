import type { AlertRecord } from '../types.js';

function formatAge(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', hour12: false,
  }) + ' UTC';
}

const PERIOD_COLOR: Record<string, string> = {
  daily:   '#6366f1',
  weekly:  '#f59e0b',
  monthly: '#ef4444',
};

interface Props {
  alerts: AlertRecord[];
}

export function AlertTable({ alerts }: Props) {
  return (
    <div className="card">
      <p className="card-title">Alert history</p>

      {alerts.length === 0 ? (
        <div className="empty-state">No alerts fired yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="alert-table">
            <thead>
              <tr>
                <th>Fired</th>
                <th>Period</th>
                <th style={{ textAlign: 'right' }}>Threshold</th>
                <th style={{ textAlign: 'right' }}>Actual</th>
                <th>Channels</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map(a => (
                <tr key={a.id}>
                  <td title={formatDateTime(a.firedAt)}>
                    <span style={{ color: 'var(--text)' }}>{formatAge(a.firedAt)}</span>
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                      {formatDateTime(a.firedAt)}
                    </span>
                  </td>
                  <td>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: 99,
                      fontSize: 11,
                      fontWeight: 600,
                      background: `${PERIOD_COLOR[a.period] ?? '#6366f1'}18`,
                      color: PERIOD_COLOR[a.period] ?? '#6366f1',
                    }}>
                      {a.period}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    ${a.thresholdUsd.toFixed(2)}
                  </td>
                  <td style={{
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: 600,
                    color: a.actualUsd > a.thresholdUsd ? 'var(--red)' : 'var(--text)',
                  }}>
                    ${a.actualUsd.toFixed(4)}
                  </td>
                  <td>
                    {a.channels.map(ch => (
                      <span key={ch} className="chip">
                        {ch === 'email' ? '✉' : '🖥'} {ch}
                      </span>
                    ))}
                    {a.channels.length === 0 && <span style={{ color: 'var(--muted)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
