// Turns a policy result into display state for the popup. Pure: no DOM, no chrome.* calls.
// Wording is chosen by message key so every string can be localized; nothing here ranks model quality.

export const PROVIDER_NAMES = Object.freeze({ claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' });
export const PROVIDER_URLS = Object.freeze({ claude: 'https://claude.ai', chatgpt: 'https://chatgpt.com', gemini: 'https://gemini.google.com' });

// state: 'loading' | 'disabled' | 'insufficient' | 'stale' | 'all_limited' | 'ready'
export function buildViewModel({ rec, inputs, prefs, now }) {
  if (!rec) return { state: 'loading' };
  if (prefs.disabled) return { state: 'disabled' };
  const withReading = inputs.filter((i) => i.hasReading);
  if (!withReading.length) return { state: 'insufficient', reason: 'no_readings' };
  if (rec.action === 'none') return { state: 'insufficient', reason: 'no_eligible_provider', considered: rec.considered };
  if (rec.action === 'wait') {
    return { state: 'all_limited', action: 'wait', waitUntil: rec.waitUntil, provider: rec.provider, confidence: rec.confidence, warnings: rec.warnings };
  }
  const staleAll = withReading.every((i) => i.forecasts.length > 0 && i.forecasts.every((f) => f.state === 'stale'));
  return {
    state: staleAll || rec.warnings.includes('stale_data') ? 'stale' : 'ready',
    action: rec.action, provider: rec.provider,
    confidence: rec.confidence,
    headroomPercent: rec.headroomPercent ?? null,
    resetAt: nextReset(inputs, rec.provider, now),
    warnings: rec.warnings,
    // Alternatives are an unranked, alphabetical list of usable providers, not a leaderboard.
    alternatives: rec.alternatives.map((c) => c.provider).sort(),
    considered: rec.considered,
    outsideWorkingHours: rec.outsideWorkingHours === true,
    inputsUsed: rec.inputsUsed,
  };
}

// Soonest future reset among the provider's windows: the "reset context" line.
export function nextReset(inputs, provider, now) {
  const input = inputs.find((i) => i.provider === provider);
  const times = (input?.forecasts ?? []).map((f) => f.resetAt).filter((t) => typeof t === 'number' && t > now);
  return times.length ? Math.min(...times) : null;
}

export const prefsKey = (p) => JSON.stringify([p.disabled, p.task, p.pinned, p.excluded, p.reservedPercent, p.workingHours]);

// Compact, content-free summary kept between popup opens to detect a changed recommendation.
export function snapshotOf(rec, inputs, prefs, now) {
  const status = {};
  for (const i of inputs) {
    const used = i.forecasts.map((f) => f.usedPercent).filter((u) => u != null);
    status[i.provider] = {
      auth: i.authenticated,
      limited: i.forecasts.some((f) => f.state === 'limited'),
      stale: i.forecasts.some((f) => f.state === 'stale'),
      used: used.length ? Math.round(Math.max(...used)) : null,
    };
  }
  return { at: now, action: rec.action, provider: rec.provider, confidence: rec.confidence, status, prefsKey: prefsKey(prefs) };
}

// Why did the recommendation change? null when it did not; otherwise { key, provider } naming the
// quota or forecast event behind it. The first matching cause wins.
export function explainChange(prev, next) {
  if (!prev || (prev.action === next.action && prev.provider === next.provider)) return null;
  if (prev.prefsKey !== next.prefsKey) return { key: 'preferences', provider: next.provider };
  const was = prev.provider ? prev.status?.[prev.provider] : null;
  const is = prev.provider ? next.status?.[prev.provider] : null;
  if (was && is) {
    if (!was.limited && is.limited) return { key: 'limit_reached', provider: prev.provider };
    if (was.auth && !is.auth) return { key: 'signed_out', provider: prev.provider };
    if (!was.stale && is.stale) return { key: 'went_stale', provider: prev.provider };
  }
  if (next.provider) {
    const before = prev.status?.[next.provider];
    const after = next.status?.[next.provider];
    if (before && after && before.limited && !after.limited) return { key: 'reset', provider: next.provider };
    if (before && after && !before.auth && after.auth) return { key: 'signed_in', provider: next.provider };
    if (before && after && before.stale && !after.stale) return { key: 'refreshed', provider: next.provider };
  }
  if (prev.action === 'use' && next.action === 'wait') return { key: 'all_limited', provider: null };
  return { key: 'quota_changed', provider: next.provider };
}
