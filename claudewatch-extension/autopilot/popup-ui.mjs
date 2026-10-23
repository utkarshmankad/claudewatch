// Autopilot card for the popup. DOM and chrome.* glue around the pure modules in this folder.
// Everything user-visible goes through t(); data is inserted with textContent, never innerHTML.
import { recommend } from './policy.mjs';
import { buildProviderInputs } from './inputs.mjs';
import { buildViewModel, snapshotOf, explainChange, PROVIDER_NAMES, PROVIDER_URLS } from './view-model.mjs';
import { warningText, consideredText, causeText, confidenceText } from './messages.mjs';
import { loadPrefs, savePrefs, loadLocal, saveLocal, LAST_KEY, DISMISS_KEY, IMPRESSION_KEY, recKey, shouldRecordImpression } from './store.mjs';

const name = (p) => PROVIDER_NAMES[p] ?? p;
let ctx = null; // { t, fmtTime, openTab, track } supplied by popup.js
let current = null; // { vm, rec, key } of the card on screen
let lastStats = null;

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};

function button(label, onClick, className = 'btn btn-ghost btn-sm') {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function initAutopilot(context) {
  ctx = context;
  render({ state: 'loading' });
}

function setBusy(busy) {
  document.getElementById('autopilot')?.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// Working hours are stored as local hours; the offset is read now so daylight-saving changes apply.
function withLocalOffset(prefs, now) {
  return prefs.workingHours ? { ...prefs, workingHours: { ...prefs.workingHours, utcOffsetMinutes: -new Date(now).getTimezoneOffset() } } : prefs;
}

export async function updateAutopilot(stats, now = Date.now()) {
  lastStats = stats;
  const stored = await loadPrefs();
  const prefs = withLocalOffset(stored, now);
  if (prefs.disabled) { current = null; setBusy(false); render({ state: 'disabled' }); return; }
  const inputs = buildProviderInputs(stats, now);
  const rec = recommend(inputs, prefs, now);
  const vm = buildViewModel({ rec, inputs, prefs, now });
  const snap = snapshotOf(rec, inputs, prefs, now);
  const prev = await loadLocal(LAST_KEY);
  const key = recKey(rec);
  const dismissed = await loadLocal(DISMISS_KEY);
  const change = explainChange(prev, snap);
  // Keep the previous summary until the recommendation actually changes, so the "changed" note
  // survives the next popup open; the dismissal is cleared only by a change of recommendation.
  if (!prev || change) await saveLocal(LAST_KEY, { ...snap, changeNote: change ? { ...change, from: { action: prev.action, provider: prev.provider }, at: now } : null });
  else await saveLocal(LAST_KEY, { ...prev, status: snap.status, at: now });
  const note = change ? { ...change, from: { action: prev.action, provider: prev.provider } } : prev?.changeNote ?? null;
  current = { vm, rec, key };
  setBusy(false);
  if (dismissed?.key === key && ['ready', 'stale', 'all_limited'].includes(vm.state)) { render({ state: 'dismissed' }); return; }
  render(vm, note);
  await recordImpression(vm, rec, key, now);
}

async function recordImpression(vm, rec, key, now) {
  if (!['ready', 'stale', 'all_limited'].includes(vm.state)) return;
  const last = await loadLocal(IMPRESSION_KEY);
  if (!shouldRecordImpression(last, key, now)) return;
  await saveLocal(IMPRESSION_KEY, { key, at: now });
  ctx.track('recommendation_impression', { action: rec.action, provider: rec.provider ?? 'none', confidence: rec.confidence, state: vm.state });
}

function changeText(note) {
  const { t } = ctx;
  const from = note.from.action === 'use' && note.from.provider ? name(note.from.provider)
    : note.from.action === 'wait' ? t('apPrevWait', undefined, 'waiting') : t('apPrevNone', undefined, 'no recommendation');
  const cause = causeText(t, note.key, note.provider ? name(note.provider) : '');
  return t('apChanged', [from, cause], `Changed from ${from}: ${cause}`);
}

function whyList(vm) {
  const { t } = ctx;
  const list = el('ul', 'ap-why-list');
  const add = (text) => { if (text) list.appendChild(el('li', null, text)); };
  for (const w of vm.warnings ?? []) add(warningText(t, w));
  if (vm.outsideWorkingHours) add(t('apWarnOutsideHours', undefined, 'Outside your working hours, five-hour limits are not counted.'));
  for (const c of vm.considered ?? []) add(consideredText(t, c.reason, name(c.provider)));
  add(t('apCoarse', undefined, 'Forecasts here are rough estimates from recent readings in this browser.'));
  add(t('apNotQuality', undefined, 'This compares remaining quota and risk, not model quality.'));
  return list;
}

function whyBlock(vm) {
  const { t } = ctx;
  const details = el('details', 'ap-why');
  const summary = el('summary', null, t('apWhy', undefined, 'Why this?'));
  details.append(summary, whyList(vm));
  details.addEventListener('toggle', () => { if (details.open) ctx.track('explanation_viewed', { action: current?.rec?.action === 'wait' ? 'wait' : 'use' }); });
  return details;
}

function dismissButton() {
  const { t } = ctx;
  return button(t('apDismiss', undefined, 'Dismiss'), async () => {
    if (!current) return;
    await saveLocal(DISMISS_KEY, { key: current.key, at: Date.now() });
    ctx.track('recommendation_dismissed', { action: current.rec.action === 'wait' ? 'wait' : 'use' });
    render({ state: 'dismissed' });
  });
}

function render(vm, note = null) {
  const body = document.getElementById('ap-body');
  if (!body) return;
  const { t } = ctx;
  body.replaceChildren();
  const status = (text, extra) => {
    const p = el('p', 'ap-status', text);
    body.appendChild(p);
    if (extra) body.appendChild(extra);
  };
  switch (vm.state) {
    case 'loading': status(t('apLoading', undefined, 'Checking your quota…')); break;
    case 'disabled':
      status(t('apDisabled', undefined, 'Autopilot recommendations are off.'), button(t('apTurnOn', undefined, 'Turn on'), async () => {
        const prefs = await loadPrefs();
        await savePrefs({ ...prefs, disabled: false });
        ctx.track('autopilot_toggled', { enabled: true });
        if (lastStats) updateAutopilot(lastStats);
      }));
      break;
    case 'dismissed': status(t('apDismissed', undefined, 'Recommendation hidden until it changes.')); break;
    case 'insufficient':
      status(vm.reason === 'no_readings'
        ? t('apInsufficientNoData', undefined, 'Not enough data yet. Open a signed-in Claude, ChatGPT or Gemini tab so Autopilot can read your quota.')
        : t('apInsufficientNone', undefined, 'No signed-in provider is available right now, so there is nothing to recommend.'));
      if (vm.considered?.length) body.appendChild(whyList(vm));
      break;
    case 'all_limited': {
      status(t('apAllLimited', undefined, 'Every available provider is at its limit.'));
      body.lastChild.classList.add('ap-headline');
      body.appendChild(el('p', 'ap-detail', vm.waitUntil
        ? t('apWaitEarliest', [name(vm.provider), ctx.fmtTime(vm.waitUntil)], `${name(vm.provider)} resets first, at ${ctx.fmtTime(vm.waitUntil)}.`)
        : t('apWaitUnknown', undefined, 'No reset time is known. Check the providers directly.')));
      if (note) body.appendChild(el('p', 'ap-change', changeText(note)));
      const actions = el('div', 'ap-actions');
      actions.append(button(t('apWaitChoose', undefined, "I'll wait"), () => {
        ctx.track('wait_chosen', { provider: vm.provider ?? 'none' });
        actions.replaceWith(el('p', 'ap-detail', t('apWaitAck', undefined, 'Noted. Autopilot updates when a provider resets.')));
      }, 'btn btn-primary btn-sm'), dismissButton());
      body.append(actions, whyBlock({ ...vm, considered: [] }));
      break;
    }
    case 'ready':
    case 'stale': {
      if (vm.state === 'stale') body.appendChild(el('p', 'ap-warn', t('apStaleNotice', undefined, 'Some quota data is out of date, so treat this as a guess.')));
      body.appendChild(el('p', 'ap-headline', t('apUse', [name(vm.provider)], `Use ${name(vm.provider)} next`)));
      const benefit = vm.headroomPercent == null
        ? t('apBenefitUnknown', undefined, 'Quota left is unknown for this provider')
        : t('apBenefit', [String(Math.round(vm.headroomPercent))], `About ${Math.round(vm.headroomPercent)}% of quota left after your reserve`);
      body.appendChild(el('p', 'ap-detail', benefit));
      // Confidence is a word, not just a colour.
      body.appendChild(el('p', 'ap-detail', t('apConfidence', [confidenceText(t, vm.confidence)], `Confidence: ${confidenceText(t, vm.confidence)}`)));
      body.appendChild(el('p', 'ap-detail', vm.resetAt
        ? t('apResets', [ctx.fmtTime(vm.resetAt)], `Resets ${ctx.fmtTime(vm.resetAt)}`)
        : t('apResetUnknown', undefined, 'Reset time unknown')));
      if (note) body.appendChild(el('p', 'ap-change', changeText(note)));
      const actions = el('div', 'ap-actions');
      actions.append(button(t('apOpen', [name(vm.provider)], `Open ${name(vm.provider)}`), () => {
        ctx.track('provider_opened', { provider: vm.provider, source: 'primary' });
        ctx.openTab(PROVIDER_URLS[vm.provider]);
      }, 'btn btn-primary btn-sm'), dismissButton());
      body.appendChild(actions);
      if (vm.alternatives.length) {
        const alt = el('div', 'ap-alts');
        alt.appendChild(el('span', 'ap-detail', t('apAlternatives', [vm.alternatives.map(name).join(', ')], `Also available: ${vm.alternatives.map(name).join(', ')}`)));
        for (const p of vm.alternatives) {
          alt.appendChild(button(t('apOpen', [name(p)], `Open ${name(p)}`), () => {
            ctx.track('provider_opened', { provider: p, source: 'alternative' });
            ctx.openTab(PROVIDER_URLS[p]);
          }, 'btn btn-ghost btn-xs'));
        }
        body.appendChild(alt);
      }
      body.appendChild(whyBlock(vm));
      break;
    }
    default: break;
  }
}
