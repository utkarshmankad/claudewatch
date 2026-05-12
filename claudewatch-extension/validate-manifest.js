#!/usr/bin/env node
// Validates manifest.json and verifies all referenced files exist.
// Run: node validate-manifest.js
// Exit 0 = all checks passed; exit 1 = one or more checks failed.

const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
let   ok   = true;

function pass(msg) { console.log(`  ✓  ${msg}`); }
function fail(msg) { console.error(`  ✗  ${msg}`); ok = false; }

function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function check(condition, passMsg, failMsg) {
  condition ? pass(passMsg) : fail(failMsg);
}

// ---------------------------------------------------------------------------
// Load manifest
// ---------------------------------------------------------------------------
console.log('\nClaudeWatch Extension — Manifest Validator\n');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  pass('manifest.json is valid JSON');
} catch (err) {
  fail(`manifest.json parse error: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Required top-level fields
// ---------------------------------------------------------------------------
console.log('\n── Required fields');
check(manifest.manifest_version === 3,
  'manifest_version is 3',
  `manifest_version should be 3, got ${manifest.manifest_version}`);

check(typeof manifest.name === 'string' && manifest.name.length > 0,
  `name: "${manifest.name}"`,
  'name is missing or empty');

check(/^\d+\.\d+\.\d+$/.test(manifest.version),
  `version: ${manifest.version}`,
  `version "${manifest.version}" should be semver (X.Y.Z)`);

check(typeof manifest.description === 'string',
  `description present`,
  'description is missing');

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
console.log('\n── Permissions');
const REQUIRED_PERMS = ['storage', 'alarms', 'notifications', 'tabs'];
for (const perm of REQUIRED_PERMS) {
  check(manifest.permissions?.includes(perm),
    `permission: ${perm}`,
    `missing permission: ${perm}`);
}

const REQUIRED_HOSTS = ['https://claude.ai/*'];
for (const host of REQUIRED_HOSTS) {
  check(manifest.host_permissions?.includes(host),
    `host_permission: ${host}`,
    `missing host_permission: ${host}`);
}

// ---------------------------------------------------------------------------
// Background service worker
// ---------------------------------------------------------------------------
console.log('\n── Background');
const swFile = manifest.background?.service_worker;
check(!!swFile, 'background.service_worker defined', 'background.service_worker missing');
if (swFile) check(fileExists(swFile), `${swFile} exists`, `${swFile} not found`);

// ---------------------------------------------------------------------------
// Action / popup
// ---------------------------------------------------------------------------
console.log('\n── Action');
const popupPage = manifest.action?.default_popup;
check(!!popupPage, 'action.default_popup defined', 'action.default_popup missing');
if (popupPage) check(fileExists(popupPage), `${popupPage} exists`, `${popupPage} not found`);

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
console.log('\n── Icons');
const iconSizes = ['16', '32', '48', '128'];
for (const size of iconSizes) {
  const iconFile = manifest.icons?.[size];
  if (iconFile) {
    check(fileExists(iconFile), `icon${size}: ${iconFile}`, `icon${size}: ${iconFile} not found`);
  } else {
    fail(`icons.${size} not declared in manifest`);
  }
}

// ---------------------------------------------------------------------------
// Content scripts
// ---------------------------------------------------------------------------
console.log('\n── Content scripts');
const scripts = manifest.content_scripts ?? [];
check(scripts.length > 0, `${scripts.length} content script(s) declared`, 'no content scripts declared');
for (const cs of scripts) {
  for (const jsFile of cs.js ?? []) {
    check(fileExists(jsFile), `${jsFile} exists`, `${jsFile} not found`);
  }
}

// ---------------------------------------------------------------------------
// Options UI
// ---------------------------------------------------------------------------
console.log('\n── Options');
const optionsPage = manifest.options_ui?.page ?? manifest.options_page;
check(!!optionsPage, 'options page declared', 'options page missing');
if (optionsPage) check(fileExists(optionsPage), `${optionsPage} exists`, `${optionsPage} not found`);

// ---------------------------------------------------------------------------
// Additional expected files
// ---------------------------------------------------------------------------
console.log('\n── Expected files');
const expectedFiles = [
  'interceptor.js',
  'content.js',
  'onboarding/onboarding.html',
  'onboarding/onboarding.css',
  'onboarding/onboarding.js',
  'settings/settings.html',
  'settings/settings.css',
  'settings/settings.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
];
for (const f of expectedFiles) {
  check(fileExists(f), `${f} exists`, `${f} not found`);
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
console.log('');
if (ok) {
  console.log('All checks passed ✓\n');
  process.exit(0);
} else {
  console.error('Some checks failed — fix the issues above before packaging.\n');
  process.exit(1);
}
