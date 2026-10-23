import { useCallback, useEffect, useState } from 'react';
import { api, ledgerQuery } from '../api.js';
import type { LedgerFilter, LedgerView, ViewState } from '../types.js';

const fmtTime = (t: number) => new Date(t).toLocaleString();
const pts = (n: number) => `${Math.round(n * 100) / 100} pts`;
const range = (r: { low: number; high: number }) => (r.low === r.high ? pts(r.low) : `${pts(r.low)} to ${pts(r.high)}`);

const STATE_MESSAGE: Record<ViewState, { title: string; body: string } | null> = {
  empty: { title: 'No ledger data yet', body: 'Turn on a collector or browse with the extension. Nothing is recorded until you opt in.' },
  no_match: { title: 'Nothing matches these filters', body: 'Widen the time range or clear a filter.' },
  stale: { title: 'Provider data is stale', body: 'The newest provider-reported value is more than 30 minutes old. Movement after that is not shown.' },
  partial: { title: 'Partial picture', body: 'Some evidence is missing, so unattributed figures may be too high or too low.' },
  ok: null,
};
const REASON_TEXT: Record<string, string> = {
  provider_snapshot_old: 'Newest provider reading is older than 30 minutes.',
  no_provider_snapshots: 'No provider-reported readings in this view, so quota movement cannot be shown.',
  snapshot_gaps: 'Long gaps between provider readings.',
  flagged_records: 'Some records had clock-skew or late-arrival flags.',
};

type Select = { key: keyof LedgerFilter; label: string; options: string[] };

export function LedgerPanel() {
  const [filter, setFilter] = useState<LedgerFilter>({});
  const [view, setView] = useState<LedgerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async (f: LedgerFilter) => {
    setLoading(true);
    try { setView(await api.ledger(f)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unknown error'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(filter); }, [filter, load]);

  const set = (key: keyof LedgerFilter, value: string) => {
    setConfirming(false); setNotice(null);
    setFilter(prev => {
      const next: Record<string, unknown> = { ...prev };
      if (value === '') delete next[key]; else next[key] = key === 'from' || key === 'to' ? Number(value) : value;
      return next as LedgerFilter;
    });
  };
  const days = (n: number) => { setConfirming(false); setFilter(prev => ({ ...prev, from: Date.now() - n * 86_400_000, to: undefined })); };
  const scoped = Object.keys(filter).filter(k => (filter as Record<string, unknown>)[k] !== undefined).length > 0;

  const remove = async () => {
    try {
      const clean = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)) as LedgerFilter;
      const { deleted } = await api.deleteLedger(clean);
      setNotice(`Deleted ${deleted} record${deleted === 1 ? '' : 's'} from this device.`);
      setConfirming(false);
      await load(filter);
    } catch (err) { setError(err instanceof Error ? err.message : 'Delete failed'); }
  };

  const opts = view?.options;
  const selects: Select[] = opts ? [
    { key: 'provider', label: 'Provider', options: opts.providers },
    { key: 'account', label: 'Account', options: opts.accounts },
    { key: 'device', label: 'Device', options: opts.devices },
    { key: 'client', label: 'Client', options: opts.clients },
    { key: 'source', label: 'Measurement', options: opts.sources },
    { key: 'confidence', label: 'Confidence', options: opts.confidences },
  ] : [];
  const msg = view ? STATE_MESSAGE[view.state] : null;
  const exportQuery = ledgerQuery(filter);

  return <section className="card ledger-panel" aria-labelledby="ledger-title" aria-busy={loading}>
    <div className="panel-heading">
      <p className="card-title" id="ledger-title">Usage ledger</p>
      <span>
        <a href={`/api/ledger/export?${exportQuery}${exportQuery ? '&' : ''}format=csv`}>Export CSV</a>{' · '}
        <a href={`/api/ledger/export?${exportQuery}`}>Export JSON</a>
      </span>
    </div>
    <p className="muted">Where your quota moved, when, and what evidence supports it. Quota points are what the provider reported. Token figures are local estimates, not billing.</p>

    {error && <div className="error-banner" role="alert"><strong>Ledger unavailable</strong> — {error}</div>}
    {loading && !view && <p className="muted" role="status">Loading ledger…</p>}
    {notice && <p role="status" className="ledger-notice">{notice}</p>}

    {view && <>
      <form className="ledger-filters" aria-label="Ledger filters" onSubmit={e => e.preventDefault()}>
        {selects.map(s => <label key={s.key}>{s.label}
          <select value={String(filter[s.key] ?? '')} onChange={e => set(s.key, e.target.value)}>
            <option value="">All</option>
            {s.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>)}
        <label>Time range
          <select value="" onChange={e => { if (e.target.value === 'all') { set('from', ''); set('to', ''); } else if (e.target.value) days(Number(e.target.value)); }}>
            <option value="">{filter.from ? `Since ${fmtTime(filter.from)}` : 'All time'}</option>
            <option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="all">All time</option>
          </select>
        </label>
        {scoped && <button type="button" className="btn" onClick={() => { setFilter({}); setConfirming(false); }}>Clear filters</button>}
      </form>

      {msg && <div className={`ledger-state ledger-state-${view.state}`} role="status">
        <strong>{msg.title}.</strong> {msg.body}
        {view.stateReasons.length > 0 && <ul>{view.stateReasons.map(r => <li key={r}>{REASON_TEXT[r] ?? r}</li>)}</ul>}
      </div>}

      {view.matched > 0 && <>
        <div className="insight-grid">
          <div><span>Provider-reported movement</span><strong>{pts(view.providerMovementPoints)}</strong></div>
          <div><span>Unattributed (no local evidence)</span><strong>{range(view.unidentifiedPoints)}</strong></div>
          <div><span>Records shown</span><strong>{view.matched.toLocaleString()}</strong></div>
        </div>

        <h3>By evidence type</h3>
        <table><thead><tr><th>Label</th><th>Records</th><th>Requests</th><th>Estimated tokens</th></tr></thead>
          <tbody>{(Object.entries(view.totalsByLabel) as Array<[string, LedgerView['totalsByLabel'][keyof LedgerView['totalsByLabel']]]>).filter(([, t]) => t.records > 0).map(([label, t]) =>
            <tr key={label}><td>{label.replace('_', '-')}</td><td>{t.records}</td><td>{t.requests || '—'}</td><td>{t.estimatedTokens ? `~${t.estimatedTokens.toLocaleString()}` : '—'}</td></tr>)}</tbody></table>

        {view.quotaChanges.length > 0 && <>
          <h3>When quota changed</h3>
          <ul className="ledger-changes">{view.quotaChanges.map(c => <li key={`${c.provider}${c.account}${c.window}${c.from}`}>
            <strong>{c.provider} / {c.account} / {c.window.replace('_', ' ')}</strong>: +{pts(c.providerDeltaPoints)} between {fmtTime(c.from)} and {fmtTime(c.to)}.{' '}
            {c.evidenceCount} local observation{c.evidenceCount === 1 ? '' : 's'} as evidence; unattributed {range(c.unattributedPoints)}.
            <details><summary>Why</summary><p>{c.explanation}</p></details>
          </li>)}</ul>
        </>}

        <h3>Records</h3>
        <table><thead><tr><th>Time</th><th>Label</th><th>Provider</th><th>Account</th><th>Client</th><th>Confidence</th><th>Value</th></tr></thead>
          <tbody>{view.rows.map(r => <tr key={r.id}>
            <td>{fmtTime(r.at)}</td><td>{r.labelText}</td><td>{r.provider}</td><td>{r.account}</td><td>{r.client}</td><td>{r.confidence}</td>
            <td>{r.quotaPercentUsed !== undefined ? `${r.quotaPercentUsed}% of ${r.window?.replace('_', ' ') ?? 'window'} (provider)` : r.estimatedTokens !== undefined ? `~${r.estimatedTokens.toLocaleString()} tokens (estimate)` : r.requestCount !== undefined ? `${r.requestCount} request${r.requestCount === 1 ? '' : 's'}` : '—'}</td>
          </tr>)}</tbody></table>
        {view.truncated && <p className="muted">Showing the newest {view.rows.length} of {view.matched.toLocaleString()}. Export includes all of them.</p>}

        <div className="ledger-delete">
          {!confirming
            ? <button type="button" className="btn" onClick={() => setConfirming(true)}>{scoped ? 'Delete matching records…' : 'Delete all ledger data…'}</button>
            : <span role="alertdialog" aria-label="Confirm delete">
                {scoped ? `Permanently delete the ${view.matched.toLocaleString()} matching records from this device?` : 'Permanently delete the entire ledger from this device?'}{' '}
                <button type="button" className="btn btn-danger" onClick={() => void remove()}>Yes, delete</button>{' '}
                <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
              </span>}
        </div>
      </>}
    </>}
    <p className="muted">{view?.caveat}</p>
  </section>;
}
