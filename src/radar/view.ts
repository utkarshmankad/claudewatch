import type { Incident, IncidentKind } from './detect.js';
import type { Provider } from './contribution.js';

// Read model for the Limit Change Radar view (prompt 4.3). Pure: labels and orders incidents from the
// detector; it never sees a contribution or a cohort below the threshold. Wording: docs/radar/UI_AND_REMOTE_CONFIG.md.

export const RADAR_DISCLAIMER =
  'Radar shows aggregated observations from opted-in Token Watcher users. These are not provider announcements and may be wrong. Check your provider before acting on them.';

export const KIND_TEXT: Record<IncidentKind, string> = {
  parser_failure: 'Usage page format changed',
  missing_fields: 'Usage fields missing',
  reset_pattern_change: 'Reset timing changed',
  quota_window_change: 'Quota window changed',
  provider_error_spike: 'Provider errors rising',
  plan_region_anomaly: 'Plan or region anomaly',
};

// Generic, non-promissory guidance per incident kind. Nothing here claims a provider cause or a fix date.
export const WORKAROUND: Record<IncidentKind, string> = {
  parser_failure: 'Readings from the affected provider may be stale. Check the provider’s own usage page and update the extension when a new version is available.',
  missing_fields: 'Some figures may be missing. Treat quota percentages for this provider as incomplete.',
  reset_pattern_change: 'Reset times shown here may be wrong. Confirm the reset time on the provider’s own page.',
  quota_window_change: 'The size or kind of the usage window may have changed. Confirm your limits with the provider before relying on forecasts.',
  provider_error_spike: 'Requests may be failing more than usual. Retrying later or using another provider may help.',
  plan_region_anomaly: 'Only some plans or regions appear affected. If you are on another plan, you may not see this.',
};

const PROVIDER_TEXT: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', copilot: 'Copilot', cursor: 'Cursor', other: 'Other providers' };
const PLAN_TEXT: Record<string, string> = { free: 'Free', individual_paid: 'Individual paid', team: 'Team', enterprise: 'Enterprise', api: 'API', unknown: 'Unknown plan' };
const REGION_TEXT: Record<string, string> = { americas: 'Americas', emea: 'Europe, Middle East, Africa', apac: 'Asia-Pacific', other: 'Other regions' };

export type ConfidenceLabel = 'low' | 'medium' | 'high';
export const confidenceLabel = (c: number): ConfidenceLabel => (c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : 'low');

export interface RadarIncidentView {
  id: string;
  kind: IncidentKind;
  title: string;
  provider: Provider;
  providerLabel: string;
  plans: string[];
  regions: string[];
  firstObserved: string;
  lastObserved: string;
  status: 'active' | 'resolved';
  resolution: string;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  sampleBand: Incident['sampleBand'];
  workaround: string;
  evidence: string;
}

export type RadarViewState = 'empty' | 'no_active' | 'ok' | 'disabled';

export interface RadarView {
  state: RadarViewState;
  disclaimer: string;
  beta: true;
  generatedAt: number;
  incidents: RadarIncidentView[];
}

export const STATE_COPY: Record<RadarViewState, string> = {
  empty: 'No Radar findings yet. Radar is in beta and has no incident feed on this device.',
  no_active: 'No active incidents. Recent ones are listed as resolved.',
  ok: '',
  disabled: 'Radar is turned off on this device.',
};

const scope = (xs: readonly string[], text: Record<string, string>, all: string) => (xs.length === 0 ? [all] : xs.map(x => text[x] ?? x));

export function toIncidentView(i: Incident): RadarIncidentView {
  return {
    id: i.id, kind: i.kind, title: KIND_TEXT[i.kind], provider: i.provider, providerLabel: PROVIDER_TEXT[i.provider],
    plans: scope(i.planTypes, PLAN_TEXT, 'All observed plans'), regions: scope(i.regionBuckets, REGION_TEXT, 'All observed regions'),
    firstObserved: i.firstObserved, lastObserved: i.lastObserved, status: i.status,
    resolution: i.status === 'active' ? 'Ongoing: still observed in the latest published data' : `Resolved: last observed ${i.lastObserved}`,
    confidence: Math.round(i.confidence * 100) / 100, confidenceLabel: confidenceLabel(i.confidence), sampleBand: i.sampleBand,
    workaround: WORKAROUND[i.kind], evidence: i.evidence,
  };
}

/** Active incidents first, then resolved; newest first within each. */
export function buildRadarView(incidents: readonly Incident[], now: number, enabled = true): RadarView {
  const views = incidents.map(toIncidentView).sort((a, b) =>
    (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || b.firstObserved.localeCompare(a.firstObserved));
  const state: RadarViewState = !enabled ? 'disabled' : views.length === 0 ? 'empty' : views.some(v => v.status === 'active') ? 'ok' : 'no_active';
  return { state, disclaimer: RADAR_DISCLAIMER, beta: true, generatedAt: now, incidents: enabled ? views : [] };
}
