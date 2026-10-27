// Companion page wiring. All content is written with textContent; nothing from the view model is parsed as HTML.
// The view model is produced by the sync client (src/sync/client) and stored in IndexedDB. Bundling that client into
// this page is not done yet (docs/sync/COMPANION.md), so an empty store shows the "Not connected" state.
import { renderView } from './render.js';
import { forgetThisDevice } from './forget.js';

const ALLOWED = new Set(['section', 'h2', 'p', 'ul', 'li', 'span', 'div']);
const ALLOWED_ATTRS = new Set(['class', 'role', 'id', 'aria-labelledby']);

function build(n) {
  if (!ALLOWED.has(n.tag)) return document.createTextNode('');
  const el = document.createElement(n.tag);
  for (const [k, v] of Object.entries(n.attrs || {})) if (ALLOWED_ATTRS.has(k)) el.setAttribute(k, String(v));
  if (n.text !== undefined) el.textContent = n.text;
  for (const c of n.children || []) el.appendChild(build(c));
  return el;
}

function readStore(key) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('claudewatch-companion', 1); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore('state');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const get = req.result.transaction('state').objectStore('state').get(key);
      get.onsuccess = () => { req.result.close(); resolve(get.result === undefined ? null : get.result); };
      get.onerror = () => { req.result.close(); resolve(null); };
    };
  });
}

function writeStore(key, value) {
  return new Promise((resolve) => {
    const req = indexedDB.open('claudewatch-companion', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('state');
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      const tx = req.result.transaction('state', 'readwrite');
      value === null ? tx.objectStore('state').delete(key) : tx.objectStore('state').put(value, key);
      tx.oncomplete = () => { req.result.close(); resolve(true); };
      tx.onerror = () => { req.result.close(); resolve(false); };
    };
  });
}

async function show() {
  const view = await readStore('view');
  const root = document.getElementById('view');
  root.replaceChildren(...renderView(view).map(build));
}

async function pushState() {
  const status = document.getElementById('push-status');
  const on = document.getElementById('push-enable');
  const off = document.getElementById('push-disable');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    status.textContent = 'This browser does not support push alerts. Open the companion to check quotas.';
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (Notification.permission === 'denied') status.textContent = 'Alerts are blocked in browser settings.';
  else status.textContent = sub ? 'Alerts are on for this device.' : 'Alerts are off.';
  on.hidden = Boolean(sub) || Notification.permission === 'denied';
  off.hidden = !sub;
}

// The public application server key is set after the owner deploys the push service; until then subscribing is not offered.
async function enable() {
  const key = await readStore('applicationServerKey');
  if (typeof key !== 'string') { document.getElementById('push-status').textContent = 'Alerts are not available until sync is set up.'; return; }
  if ((await Notification.requestPermission()) !== 'granted') return pushState();
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  // The sync client registers this with the service using its own device session; this page never holds credentials.
  await writeStore('pendingSubscription', sub.toJSON());
  return pushState();
}

async function disable() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  await writeStore('pendingSubscription', null);
  await writeStore('revokeSubscription', true); // the sync client sees this and calls DELETE /v1/push/subscription
  return pushState();
}

// Two steps: "Forget this device" only asks; "Erase now" erases. The sync client cannot be told after the data is gone,
// so the user is also told to remove the device from the list on a trusted device.
function forgetPrompt(asking) {
  document.getElementById('forget-ask').hidden = asking;
  document.getElementById('forget-confirm').hidden = !asking;
  document.getElementById('forget-cancel').hidden = !asking;
  document.getElementById('forget-status').textContent = asking ? 'This erases the stored view, the alert subscription and the offline files on this device.' : '';
}

async function forget() {
  const r = await forgetThisDevice({ indexedDB, caches: 'caches' in window ? caches : null, serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : null, dbName: 'claudewatch-companion' });
  forgetPrompt(false);
  document.getElementById('forget-status').textContent = r.database && r.caches && r.worker && r.push
    ? 'This device was forgotten. Remove it from the device list on a trusted device too.'
    : 'Some data could not be removed. Clear site data in the browser settings.';
  document.getElementById('view').replaceChildren(...renderView(null).map(build));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(pushState, () => undefined);
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'resubscribe') pushState(); });
}
document.getElementById('push-enable').addEventListener('click', enable);
document.getElementById('push-disable').addEventListener('click', disable);
document.getElementById('forget-ask').addEventListener('click', () => forgetPrompt(true));
document.getElementById('forget-cancel').addEventListener('click', () => forgetPrompt(false));
document.getElementById('forget-confirm').addEventListener('click', forget);
show();
