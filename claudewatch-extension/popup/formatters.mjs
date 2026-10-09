export function validEpochMs(value) {
  const epochMs = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(epochMs) ? epochMs : null;
}

export function formatWindowEnd(value, { locale, timeZone } = {}) {
  const epochMs = validEpochMs(value);
  if (epochMs == null) return '—';

  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(epochMs));
}
