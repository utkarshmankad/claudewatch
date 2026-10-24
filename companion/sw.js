// ClaudeWatch companion service worker (prompt 3.4). Classic script, no imports, no network fetch of its own.
// A push carries only {v, k}: a schema version and an alert kind. It never contains usage values, so the text
// shown below is fixed per kind and the page shows the real numbers once the user opens it.
const CACHE = 'claudewatch-companion-shell-v1';
const SHELL = ['./', './index.html', './app.js', './render.js', './style.css', './manifest.webmanifest'];
const TEXT = {
  quota_risk: { title: 'ClaudeWatch: quota risk', body: 'A quota may run out before it resets. Open ClaudeWatch for details.' },
  reset: { title: 'ClaudeWatch: quota reset', body: 'A quota window has reset. Open ClaudeWatch for details.' },
};

function notificationFor(data) {
  let parsed = null;
  try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = null; }
  const kind = parsed && parsed.v === 1 && Object.prototype.hasOwnProperty.call(TEXT, parsed.k) ? parsed.k : null;
  // Browsers require every push to show something; an unknown payload gets the generic quota-risk text.
  const text = TEXT[kind || 'quota_risk'];
  // tag + renotify:false collapses repeats of the same kind into one visible notification.
  return { title: text.title, options: { body: text.body, tag: 'claudewatch-' + (kind || 'quota_risk'), renotify: false, icon: 'icon.svg', data: { kind: kind } } };
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Same-origin shell files only; any other request goes straight to the network and is never cached.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
});

self.addEventListener('push', (event) => {
  const n = notificationFor(event.data ? event.data.text() : null);
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((all) => (all.length ? all[0].focus() : self.clients.openWindow('./'))));
});

// The push service rotated or expired the subscription: tell open pages so the user can re-subscribe. The worker
// holds no sync credentials and cannot re-register by itself.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((all) => all.forEach((c) => c.postMessage({ type: 'resubscribe' }))));
});
