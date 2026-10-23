# Autopilot alerts and the alert experiment

Prompt 2.4 (`2026-10-10.1/prompt-2.4`). Decision alerts replace threshold-only alerts in the extension. They are computed in the service worker from the same policy code as the popup card (`autopilot/policy.mjs`), so the worker is an ES module (`"type": "module"` in the manifest, `import` instead of `importScripts`).

## When an alert fires

| Kind | Fires when | Frequency setting |
| --- | --- | --- |
| `action_changed` | the recommended action or provider changed since the last evaluation, and the data is not stale or history-less | important, all |
| `block_likely` | the recommended provider carries a `limit_expected_soon` or `high_exhaustion_risk` warning | important, all |
| `reset_approaching` | a provider that is limited (and not the recommendation) resets in 15 minutes or less in every blocking window | all |
| `plan_review` | a weekly window is at 90 percent or more with confidence above low and over 48 hours to reset | all |

`notificationFrequency` `off` shows nothing. The first evaluation after install never alerts (there is no previous recommendation to compare with).

## Suppression

In this order: frequency, muted provider (per-provider control), quiet hours, dedupe, cooldown.

- **Dedupe**: the same kind, provider and action is not repeated within 6 hours.
- **Cooldown**: the same kind and provider waits the cooldown (default 60 minutes, 15 to 720 in settings); `plan_review` waits 24 hours.
- **Quiet hours**: a local-time range (offset re-read at each evaluation). Alerts that fall inside it are dropped, not queued.
- Suppressed alerts are counted by reason in `autopilot_alert_state.suppressed`.

## Notification history

The last 50 notifications are kept on this device (`autopilot_alert_history`): time, kind, provider, level, experiment arm, outcome and the user's rating. Settings lists them and lets the user rate each "Useful" or "False alarm". No quota values, account identifiers or message content are stored.

## Experiment

Opt-in only (settings, "Join the alert experiment"). On opt-in the device flips a coin once and keeps the arm:

- `threshold`: a single alert when any usage window passes 80 percent, once per window until it resets (the old behaviour).
- `autopilot`: the decision alerts above.

Users who do not opt in get decision alerts and record nothing for the experiment.

**Success** is a provider switch, an explicit wait choice, or a plan change within 60 minutes of the alert (opening the provider from the notification or the popup, "wait" in the popup, `SET_PLAN`). Alerts with no action in that window close as `ignored`; closing the notification records `dismiss`.

**Report** (Settings, shown once an arm is assigned; per arm in `buildReport`): alerts shown, action rate, dismissals, notification disables (switching frequency to Off), false-positive ratings, and forecast error. Forecast error is the share of `block_likely` alerts, judged after 6 hours, where the provider never showed a limited reading. Rates are `null` when there is nothing to divide, not zero.

Nothing leaves the device. Analytics events (`autopilot_alert_shown`, `autopilot_alert_action`, `alert_feedback`, `experiment_assigned`) are enum-only and local.

### Removing the experiment after the decision

1. Users: Settings, "Remove alert history and experiment data" clears history, state, arm and counters and opts out.
2. Code: delete `autopilot/experiment.mjs`, `thresholdCandidates` and the `arm` handling in `autopilot/alert-runner.mjs`, the experiment controls in `settings/settings.html` and `settings/alert-settings.mjs`, and the `experiment_assigned` event. Keep the history if the notification log stays.
3. Storage keys to clean on upgrade: `autopilot_experiment`, and `experimentOptIn` inside `autopilotAlertPrefs`.

## Known limits

- No beta decision exists. The 20 percent action-rate target for the phase gate is **not measured**; this change only provides the instrument. Real numbers come from the beta and belong to the final gate evidence.
- Forecasts in the extension are coarse (see AUTOPILOT.md), so `block_likely` is a trend bucket, not a calibrated probability.
- Quiet-hour alerts are dropped, so a reset that falls in quiet hours is not announced later.
- Attribution is by time and provider; an action that would have happened anyway is credited to the alert.
- Chrome closes and reopens the service worker; history and state are in `chrome.storage.local`, so a restart loses nothing.
