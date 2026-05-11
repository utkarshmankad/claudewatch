// Settings page script: loads from chrome.storage.sync, saves user
// preferences, and updates the About section from runtime / local storage.

const DEFAULTS = {
  alertsEnabled: true,
  thresholds:    [80, 90, 95],
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function syncGet(defaults) {
  return new Promise((resolve) => chrome.storage.sync.get(defaults, resolve));
}

function syncSet(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, resolve));
}


// ---------------------------------------------------------------------------
// Form ↔ settings mapping
// ---------------------------------------------------------------------------

/** Populate form controls from a settings object */
function applyToForm(settings) {
  id('alerts-enabled').checked = !!settings.alertsEnabled;
  id('t-80').checked = settings.thresholds.includes(80);
  id('t-90').checked = settings.thresholds.includes(90);
  id('t-95').checked = settings.thresholds.includes(95);
  syncThresholdsCard();
}

/** Read current form state into a settings object */
function collectFromForm() {
  const thresholds = [80, 90, 95].filter((t) => id(`t-${t}`).checked);
  return {
    alertsEnabled: id('alerts-enabled').checked,
    thresholds,
  };
}

/** Dim the thresholds card when alerts are disabled */
function syncThresholdsCard() {
  const card = id('thresholds-card');
  if (!card) return;
  card.classList.toggle('disabled', !id('alerts-enabled').checked);
}

// ---------------------------------------------------------------------------
// About section
// ---------------------------------------------------------------------------

function renderAbout() {
  const manifest = chrome.runtime.getManifest();
  setText('about-version', manifest.version);
  setText('about-ext-id',  chrome.runtime.id);
}

// ---------------------------------------------------------------------------
// Save / reset
// ---------------------------------------------------------------------------

let confirmTimer = null;

async function save(settings) {
  await syncSet(settings);

  // Flash the confirmation
  const el = id('save-confirm');
  el.textContent = 'Saved ✓';
  el.classList.add('visible');
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => el.classList.remove('visible'), 2500);
}

async function resetToDefaults() {
  await syncSet(DEFAULTS);
  applyToForm(DEFAULTS);
  id('conn-result').textContent = '';
  id('conn-result').className   = 'field-hint';

  const el = id('save-confirm');
  el.textContent = 'Reset to defaults ✓';
  el.classList.add('visible');
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => el.classList.remove('visible'), 2500);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function id(elementId) { return document.getElementById(elementId); }

function setText(elementId, text) {
  const node = id(elementId);
  if (node) node.textContent = text ?? '—';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Show version chip in header
  const manifest = chrome.runtime.getManifest();
  setText('version', `v${manifest.version}`);

  // Load and apply settings
  const settings = await syncGet(DEFAULTS);
  applyToForm(settings);
  renderAbout();

  // Toggle switch → dim/undim thresholds section
  id('alerts-enabled').addEventListener('change', syncThresholdsCard);

  // Form submit → save
  id('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await save(collectFromForm());
  });

  // Reset button
  id('btn-reset').addEventListener('click', async () => {
    if (confirm('Reset all settings to defaults?')) await resetToDefaults();
  });
});
