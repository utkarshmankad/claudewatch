export function validEpochMs(value) {
  const epochMs = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(epochMs) ? epochMs : null;
}

export function formatWindowEnd(value, { locale, timeZone } = {}) {
  const epochMs = validEpochMs(value);
  if (epochMs == null) return '—';

  return new Intl.DateTimeFormat(locale ?? globalThis.TokenWatcherI18n?.formatLocale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(epochMs));
}

// Caption under a gauge. `source` says where the shown percentage came from:
// 'provider_reported', 'local_estimate', or null when there is no reading to show.
// When there is none, the caption says why instead of leaving a bare dash.
export function quotaCaption({ source, forecastMeta = null, errorCategory = null, fmtPct, contract }) {
  if (source === 'local_estimate') return 'Estimate from local tokens, not provider-reported';
  if (source !== 'provider_reported') return contract.describeUnavailable(errorCategory ?? 'window_unavailable');
  const forecast = contract.formatForecast(forecastMeta, fmtPct);
  if (!forecast) return 'Provider-reported';
  const confidence = forecastMeta.confidence ? ` (${forecastMeta.confidence} confidence)` : '';
  return forecastMeta.saturated
    ? `Provider-reported · forecast: ${forecast} before reset${confidence}`
    : `Provider-reported · forecast ${forecast.replace('→ ', '')}${confidence}`;
}
