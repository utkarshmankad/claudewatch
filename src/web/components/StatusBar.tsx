interface Props {
  lastUpdated: Date | null;
  error: string | null;
  pollInterval: number;  // seconds
}

function formatAge(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 5)   return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

export function StatusBar({ lastUpdated, error, pollInterval }: Props) {
  const connected = !error && lastUpdated !== null;

  return (
    <div className="topbar-right">
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={`status-dot ${connected ? 'ok' : error ? 'error' : 'warn'}`} />
        <span className="status-label">
          {error
            ? 'Disconnected — daemon not running?'
            : lastUpdated
              ? `Updated ${formatAge(lastUpdated)}`
              : 'Connecting…'}
        </span>
      </span>
      <span className="status-label" style={{ color: '#cbd5e1' }}>
        Polls every {pollInterval}s
      </span>
    </div>
  );
}
