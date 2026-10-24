import { useState } from 'react';
import type { WrappedChoices, WrappedPreviewResponse } from '../types.js';

// Private weekly Usage Wrapped (Prompt 5.2, operation key 2026-10-10.1/prompt-5.2). Nothing is requested until the
// user opens it; export is offered only after the privacy preview is shown and acknowledged. Rules: docs/WRAPPED_REPORT.md.
const FORMATS: Array<{ id: 'html' | 'svg' | 'pdf'; label: string }> = [{ id: 'html', label: 'HTML' }, { id: 'svg', label: 'Image (SVG)' }, { id: 'pdf', label: 'PDF' }];

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function toggle(list: string[], v: string): string[] { return list.includes(v) ? list.filter(x => x !== v) : [...list, v]; }

export async function svgToPng(svg: string): Promise<Blob> {
  const w = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 800), h = Number(/height="(\d+)"/.exec(svg)?.[1] ?? 600);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('image_render_failed')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas_unavailable');
    ctx.scale(2, 2); ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((ok, bad) => canvas.toBlob(b => (b ? ok(b) : bad(new Error('png_failed'))), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

export function WrappedPanel() {
  const [open, setOpen] = useState(false);
  const [tz, setTz] = useState(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } });
  const [week, setWeek] = useState('');
  const [choices, setChoices] = useState<WrappedChoices | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [devices, setDevices] = useState<string[]>([]);
  const [names, setNames] = useState(false);
  const [data, setData] = useState<WrappedPreviewResponse | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = () => {
    const q = new URLSearchParams();
    if (tz) q.set('tz', tz);
    if (week) q.set('week', week);
    if (accounts.length) q.set('accounts', accounts.join(','));
    if (providers.length) q.set('providers', providers.join(','));
    if (devices.length) q.set('devices', devices.join(','));
    if (names) q.set('names', '1');
    return q;
  };

  const run = async () => {
    setBusy(true); setError(null); setReviewed(false);
    try {
      const cq = new URLSearchParams(); if (tz) cq.set('tz', tz); if (week) cq.set('week', week);
      if (!choices) setChoices(await getJson<WrappedChoices>(`/api/wrapped/choices?${cq}`));
      setData(await getJson<WrappedPreviewResponse>(`/api/wrapped?${query()}`));
    } catch (err) { setError(err instanceof Error ? err.message : 'Unknown error'); setData(null); }
    finally { setBusy(false); }
  };

  const exportHref = (format: string) => { const q = query(); q.set('format', format); if (data) q.set('token', data.preview.token); return `/api/wrapped/export?${q}`; };
  const downloadPng = async () => {
    if (!data) return;
    try {
      const blob = await svgToPng(data.svg);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'usage-wrapped.png'; a.click(); URL.revokeObjectURL(a.href);
    } catch (err) { setError(err instanceof Error ? err.message : 'PNG export failed'); }
  };

  const group = (legend: string, all: string[], sel: string[], set: (v: string[]) => void, label: (v: string, i: number) => string) => all.length > 0 && (
    <fieldset className="wrapped-group"><legend>{legend}</legend>
      {all.map((v, i) => <label key={v} className="wrapped-check"><input type="checkbox" checked={sel.includes(v)} onChange={() => { set(toggle(sel, v)); setData(null); }} /> {label(v, i)}</label>)}
      <span className="wrapped-hint">{sel.length === 0 ? 'All included' : `${sel.length} selected`}</span>
    </fieldset>
  );

  return <section className="card wrapped-panel" aria-labelledby="wrapped-title">
    <div className="panel-heading"><p className="card-title" id="wrapped-title">Usage Wrapped <span className="badge">Private</span></p>
      <button type="button" className="btn" aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next && !choices && !data) void run(); }}>{open ? 'Close' : 'Open weekly report'}</button></div>
    {!open && <p className="wrapped-hint">Built on this device from your local ledger. Nothing is uploaded.</p>}
    {open && <>
      <div className="wrapped-controls">
        <label>Week (any day in it) <input type="date" value={week} onChange={e => { setWeek(e.target.value); setData(null); }} /></label>
        <label>Time zone <input type="text" value={tz} onChange={e => { setTz(e.target.value); setData(null); }} /></label>
        {group('Accounts', choices?.accounts ?? [], accounts, setAccounts, v => v)}
        {group('Providers', choices?.providers ?? [], providers, setProviders, v => v)}
        {group('Devices', choices?.devices ?? [], devices, setDevices, (_v, i) => `Device ${i + 1}`)}
        <label className="wrapped-check"><input type="checkbox" checked={names} onChange={e => { setNames(e.target.checked); setData(null); }} /> Show account names in the report</label>
        <button type="button" className="btn" onClick={() => void run()} disabled={busy}>{busy ? 'Building...' : 'Build report'}</button>
      </div>
      {error && <p role="alert" className="wrapped-error">Could not build the report: {error}</p>}
      {data && <>
        <iframe title="Usage Wrapped report preview" sandbox="" srcDoc={data.html} className="wrapped-frame" />
        <div className="wrapped-privacy" role="region" aria-label="Privacy preview">
          <h3>Privacy preview</h3>
          <p>An export contains:</p>
          <ul>{data.preview.includes.map(i => <li key={i.field}><strong>{i.field}:</strong> {i.detail}</li>)}</ul>
          <p>It does not contain:</p>
          <ul>{data.preview.excludes.map(e => <li key={e}>{e}</li>)}</ul>
          {data.preview.warnings.map(w => <p key={w} role="note"><strong>Note:</strong> {w}</p>)}
          <label className="wrapped-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> I have reviewed what will be exported</label>
          <div className="wrapped-export">
            {FORMATS.map(f => reviewed ? <a key={f.id} className="btn" href={exportHref(f.id)} download>Export {f.label}</a> : <span key={f.id} className="btn" aria-disabled="true">Export {f.label}</span>)}
            <button type="button" className="btn" disabled={!reviewed} onClick={() => void downloadPng()}>Export Image (PNG)</button>
          </div>
        </div>
      </>}
    </>}
  </section>;
}
