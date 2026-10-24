import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import express, { type Express } from 'express';
import { buildRadarView } from '../radar/view.js';
import { DEFAULT_NOTIFY_PREFS, validatePrefs, type RadarNotifyPrefs } from '../radar/notify.js';
import { buildDiagnosticReport, exportReport, previewReport, type DiagnosticInput } from '../radar/diagnostics.js';
import type { Incident } from '../radar/detect.js';
import type { RemoteConfigManager } from '../radar/remoteConfig.js';
import { VERSION } from '../version.js';

export interface RadarRouteDeps {
  prefsPath: () => string;
  /** Published incident feed. There is no deployed feed yet, so the default is empty. */
  incidents?: () => readonly Incident[];
  remoteConfig?: () => RemoteConfigManager | null;
  now?: () => number;
}

export function readPrefs(path: string): RadarNotifyPrefs {
  try {
    if (!existsSync(path)) return { ...DEFAULT_NOTIFY_PREFS };
    const v = validatePrefs(JSON.parse(readFileSync(path, 'utf8')));
    return v.ok ? v.value : { ...DEFAULT_NOTIFY_PREFS };
  } catch { return { ...DEFAULT_NOTIFY_PREFS }; }
}

function writePrefs(path: string, prefs: RadarNotifyPrefs): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(prefs), { mode: 0o600 });
  renameSync(tmp, path);
}

// Local-only Radar API for the dashboard. Nothing here sends data off the machine.
export function registerRadarRoutes(app: Express, deps: RadarRouteDeps): void {
  const now = deps.now ?? Date.now;
  const json = express.json({ limit: '4kb' });

  app.get('/api/radar', (_req, res) => {
    res.json(buildRadarView(deps.incidents?.() ?? [], now()));
  });

  app.get('/api/radar/prefs', (_req, res) => { res.json(readPrefs(deps.prefsPath())); });

  app.put('/api/radar/prefs', json, (req, res) => {
    const v = validatePrefs(req.body);
    if (!v.ok) { res.status(400).json({ error: 'invalid_preferences', details: v.errors }); return; }
    try { writePrefs(deps.prefsPath(), v.value); res.json(v.value); }
    catch (err) { console.error('[/api/radar/prefs]', err); res.status(500).json({ error: 'prefs_unwritable' }); }
  });

  const report = () => {
    const mgr = deps.remoteConfig?.() ?? null;
    const input: DiagnosticInput = {
      appVersion: VERSION, radarContributionEnabled: false, radarNotificationsEnabled: readPrefs(deps.prefsPath()).enabled,
      remoteConfigVersion: mgr?.active()?.version ?? null, audit: mgr?.history() ?? [], parserCounts: [],
    };
    return buildDiagnosticReport(input);
  };

  app.get('/api/radar/diagnostics', (_req, res) => { res.json(previewReport(report())); });

  app.get('/api/radar/diagnostics/export', (req, res) => {
    try {
      const body = exportReport(report(), req.query['reviewed'] === 'yes');
      res.type('application/json').set('Content-Disposition', 'attachment; filename="tokenwatcher-diagnostics.json"').send(body);
    } catch { res.status(400).json({ error: 'review_required' }); }
  });

  app.post('/api/radar/config/rollback', (_req, res) => {
    const mgr = deps.remoteConfig?.() ?? null;
    if (!mgr) { res.status(404).json({ error: 'remote_config_unavailable' }); return; }
    res.json(mgr.rollback('user'));
  });
}
