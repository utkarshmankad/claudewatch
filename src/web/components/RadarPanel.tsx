import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import type { DiagnosticPreview, RadarNotifyPrefs, RadarView } from '../types.js';

const fmt = (iso: string) => new Date(iso).toLocaleString();

export function RadarPanel() {
  const [view, setView] = useState<RadarView | null>(null);
  const [prefs, setPrefs] = useState<RadarNotifyPrefs | null>(null);
  const [report, setReport] = useState<DiagnosticPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const [v, p] = await Promise.all([api.radar(), api.radarPrefs()]); setView(v); setPrefs(p); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unknown error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (next: RadarNotifyPrefs) => {
    setPrefs(next);
    try { setPrefs(await api.saveRadarPrefs(next)); setNotice('Notification settings saved on this device.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save settings'); await load(); }
  };
  const openReport = async () => {
    setReviewed(false);
    try { setReport(await api.radarDiagnostics()); } catch (err) { setError(err instanceof Error ? err.message : 'Could not build report'); }
  };

  return <section className="card radar-panel" aria-labelledby="radar-title">
    <div className="panel-heading"><p className="card-title" id="radar-title">Limit Change Radar <span className="badge">Beta</span></p></div>
    {error && <div role="alert">{error}</div>}
    {notice && <div role="status">{notice}</div>}
    {view && <>
      <p>{view.disclaimer}</p>
      {view.state !== 'ok' && <p>{{ empty: 'No Radar findings yet. Radar is in beta and has no incident feed on this device.', no_active: 'No active incidents. Recent ones are listed as resolved.', disabled: 'Radar is turned off on this device.', ok: '' }[view.state]}</p>}
      {view.incidents.length > 0 && <ul className="radar-incidents">
        {view.incidents.map(i => <li key={i.id}>
          <strong>{i.providerLabel}: {i.title}</strong> ({i.status === 'active' ? 'Active' : 'Resolved'})
          <dl>
            <dt>Affected</dt><dd>{i.plans.join(', ')} · {i.regions.join(', ')}</dd>
            <dt>First observed</dt><dd>{fmt(i.firstObserved)}</dd>
            <dt>Confidence</dt><dd>{i.confidenceLabel} ({Math.round(i.confidence * 100)}%)</dd>
            <dt>Sample</dt><dd>{i.sampleBand} contributors</dd>
            <dt>Status</dt><dd>{i.resolution}</dd>
            <dt>Workaround</dt><dd>{i.workaround}</dd>
          </dl>
        </li>)}
      </ul>}
    </>}
    {prefs && <fieldset>
      <legend>Incident notifications</legend>
      <label><input type="checkbox" checked={prefs.enabled} onChange={e => void save({ ...prefs, enabled: e.target.checked })} /> Notify me about Radar incidents</label>
      <label> Minimum confidence{' '}
        <select value={prefs.minConfidence} disabled={!prefs.enabled} onChange={e => void save({ ...prefs, minConfidence: Number(e.target.value) })}>
          <option value={0.25}>Low (25%)</option><option value={0.5}>Medium (50%)</option><option value={0.75}>High (75%)</option>
        </select>
      </label>
      <label><input type="checkbox" checked={prefs.notifyOnResolved} disabled={!prefs.enabled} onChange={e => void save({ ...prefs, notifyOnResolved: e.target.checked })} /> Also tell me when an incident resolves</label>
    </fieldset>}
    <div>
      <button type="button" onClick={() => void openReport()}>Review diagnostic report</button>
      {report && <div>
        <p>This is everything the report contains. Nothing is sent until you attach it to a support request yourself.</p>
        <pre aria-label="Diagnostic report contents">{report.json}</pre>
        <p>Never included: {report.neverIncluded.join('; ')}.</p>
        <label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> I reviewed this report</label>
        {reviewed ? <a href="/api/radar/diagnostics/export?reviewed=yes">Download report</a> : <span> Download is available after you confirm.</span>}
      </div>}
    </div>
  </section>;
}
