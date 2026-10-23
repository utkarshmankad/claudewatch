// Localized wording for Autopilot codes. Each message is a literal lookup call (key, substitutions,
// English fallback) so the locale tests can see which catalog keys are used. `t` is the page's lookup.

export function warningText(t, code) {
  const m = {
    stale_data: () => t('apWarn_stale_data', undefined, 'Quota data is out of date.'),
    no_history: () => t('apWarn_no_history', undefined, 'There is not enough history to forecast.'),
    limit_expected_soon: () => t('apWarn_limit_expected_soon', undefined, 'The limit may arrive within 30 minutes.'),
    high_exhaustion_risk: () => t('apWarn_high_exhaustion_risk', undefined, 'Limit risk is high before the reset.'),
    degraded_provider: () => t('apWarn_degraded_provider', undefined, 'The provider reports degraded service.'),
    pinned_unavailable: () => t('apWarn_pinned_unavailable', undefined, 'Your preferred provider has no data.'),
    pinned_blocked: () => t('apWarn_pinned_blocked', undefined, 'Your preferred provider is at its limit.'),
    pinned_ineligible: () => t('apWarn_pinned_ineligible', undefined, 'Your preferred provider is not usable right now.'),
    close_call: () => t('apWarn_close_call', undefined, 'The next option is nearly as good.'),
    single_candidate: () => t('apWarn_single_candidate', undefined, 'Only one provider is available.'),
    conflicting_windows: () => t('apWarn_conflicting_windows', undefined, 'Another usage window is at its limit.'),
    wait_until_unknown: () => t('apWarn_wait_until_unknown', undefined, 'No reset time is known.'),
  }[code];
  return m ? m() : null;
}

export function consideredText(t, reason, provider) {
  const m = {
    excluded: () => t('apConsidered_excluded', [provider], `${provider}: excluded by you`),
    unauthenticated: () => t('apConsidered_unauthenticated', [provider], `${provider}: no recent reading, or signed out`),
    offline: () => t('apConsidered_offline', [provider], `${provider}: not reachable`),
    privacy_restricted: () => t('apConsidered_privacy_restricted', [provider], `${provider}: restricted for privacy`),
  }[reason];
  return m ? m() : null;
}

export function causeText(t, key, provider) {
  const m = {
    preferences: () => t('apCause_preferences', undefined, 'you changed your Autopilot preferences'),
    limit_reached: () => t('apCause_limit_reached', [provider], `${provider} reached its limit`),
    signed_out: () => t('apCause_signed_out', [provider], `${provider} looks signed out`),
    went_stale: () => t('apCause_went_stale', [provider], `${provider} data went out of date`),
    reset: () => t('apCause_reset', [provider], `${provider} reset and is available again`),
    signed_in: () => t('apCause_signed_in', [provider], `${provider} signed in`),
    refreshed: () => t('apCause_refreshed', [provider], `${provider} data was refreshed`),
    all_limited: () => t('apCause_all_limited', undefined, 'every provider reached its limit'),
  }[key];
  return (m ?? (() => t('apCause_quota_changed', undefined, 'quota readings changed')))();
}

export function confidenceText(t, level) {
  if (level === 'high') return t('apConfHigh', undefined, 'high');
  if (level === 'medium') return t('apConfMedium', undefined, 'medium');
  return t('apConfLow', undefined, 'low');
}

export function taskText(t, task) {
  const m = {
    coding: () => t('apTask_coding', undefined, 'Coding'),
    research: () => t('apTask_research', undefined, 'Research'),
    writing: () => t('apTask_writing', undefined, 'Writing'),
    analysis: () => t('apTask_analysis', undefined, 'Analysis'),
    general: () => t('apTask_general', undefined, 'General chat'),
  }[task];
  return m ? m() : task;
}

export function frequencyText(t, value) {
  const m = {
    off: () => t('apNotify_off', undefined, 'Off'),
    important: () => t('apNotify_important', undefined, 'Important only'),
    all: () => t('apNotify_all', undefined, 'All changes'),
  }[value];
  return m ? m() : value;
}

// Title and body of an Autopilot alert notification. `name` is the provider's display name (may be empty).
export function alertText(t, alert, name) {
  const cause = alert.cause ? causeText(t, alert.cause.key, alert.cause.provider ? name : '') : '';
  const m = {
    action_changed: () => alert.action === 'wait'
      ? { title: t('apAlert_changedWait_title', undefined, 'Autopilot: wait for a reset'), message: t('apAlert_changedWait_body', undefined, 'Every provider has reached its limit. Waiting for a reset is the best option.') }
      : { title: t('apAlert_changedUse_title', [name], `Autopilot: use ${name} next`), message: t('apAlert_changedUse_body', [cause], `The recommendation changed because ${cause}.`) },
    block_likely: () => ({ title: t('apAlert_block_title', [name], `${name} may hit its limit soon`), message: t('apAlert_block_body', undefined, 'Quota is running down faster than the reset. Consider switching provider.') }),
    reset_approaching: () => ({ title: t('apAlert_reset_title', [name], `${name} resets soon`), message: t('apAlert_reset_body', undefined, 'It will be available again in about 15 minutes.') }),
    plan_review: () => ({ title: t('apAlert_plan_title', [name], `${name} weekly quota is nearly used`), message: t('apAlert_plan_body', undefined, 'Most of the week is left. Review your plan or spread out your usage.') }),
    threshold: () => ({ title: t('apAlert_threshold_title', [name], `${name} quota is running high`), message: t('apAlert_threshold_body', undefined, 'A usage window passed your alert threshold.') }),
  }[alert.kind];
  return m ? m() : { title: t('apAlert_generic_title', undefined, 'Autopilot'), message: '' };
}

export const openProviderText = (t) => t('apAlert_open', undefined, 'Open provider');
