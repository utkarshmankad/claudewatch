import type { AnalyticsResponse } from '../types.js';

export function AnalyticsPanel({ analytics }: { analytics: AnalyticsResponse | null }) {
  if (!analytics) return <section className="card"><p className="card-title">Usage intelligence</p><p className="muted">Waiting for attributed browser or code-assistant events.</p></section>;
  return <section className="card analytics-panel">
    <div className="panel-heading"><p className="card-title">Usage intelligence</p><a href="/api/report?days=30&format=csv">Export CSV</a></div>
    <div className="insight-grid">
      <div><span>Observed</span><strong>{analytics.reconciliation.observedTokens.toLocaleString()}</strong></div>
      <div><span>Unattributed</span><strong>{analytics.reconciliation.unattributedTokens?.toLocaleString() ?? '—'}</strong></div>
      <div><span>Plan fit</span><strong>{analytics.planRecommendation.status}</strong></div>
    </div>
    <p className="muted">{analytics.planRecommendation.message}</p>
    <table><thead><tr><th>Provider</th><th>Client</th><th>Confidence</th><th>Tokens</th><th>Events</th></tr></thead>
      <tbody>{analytics.attribution.map(row => <tr key={`${row.provider}:${row.client}:${row.confidence}`}><td>{row.provider}</td><td>{row.client}</td><td>{row.confidence}</td><td>{(row.inputTokens + row.outputTokens).toLocaleString()}</td><td>{row.events}</td></tr>)}</tbody>
    </table>
    {analytics.leaderboard.length > 0 && <div className="leaderboard"><h3>Team activity</h3>{analytics.leaderboard.slice(0, 5).map((row, i) => <div key={row.userId}><span>{i + 1}. {row.userId}</span><strong>{row.tokens.toLocaleString()}</strong></div>)}</div>}
    <p className="muted">{analytics.reconciliation.caveat}</p>
  </section>;
}
