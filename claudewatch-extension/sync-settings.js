// Opt-in policy for end-to-end encrypted sync. Pure: no chrome.* access and no network calls.
// The service origin is pinned in the build (docs/sync/ARCHITECTURE.md, T10): there is no
// user-supplied URL. Until the owner deploys the service and sets SYNC_ORIGIN, sync cannot be
// enabled and the extension stays local-only.
(function registerSyncSettings(scope) {
  const SYNC_ORIGIN = null;
  const DEFAULTS = { cloudSyncEnabled: false };
  // Private device keys belong in chrome.storage.local, never chrome.storage.sync.
  const KEY_STORAGE_AREA = 'local';

  const isAvailable = (origin = SYNC_ORIGIN) => typeof origin === 'string' && /^https:\/\/[^/*\s]+$/.test(origin);
  const permissionPattern = (origin = SYNC_ORIGIN) => (isAvailable(origin) ? `${origin}/*` : null);

  // True only when the user opted in, the build pins an origin, and the host permission is granted.
  function mayUseNetwork(settings, granted, origin = SYNC_ORIGIN) {
    return !!(settings && settings.cloudSyncEnabled === true && granted === true && isAvailable(origin));
  }

  // Settings after a save attempt: a denied or unavailable permission forces local-only.
  function resolveOptIn(requested, granted, origin = SYNC_ORIGIN) {
    return { cloudSyncEnabled: requested === true && granted === true && isAvailable(origin) };
  }

  scope.TokenWatcherSyncSettings = { SYNC_ORIGIN, DEFAULTS, KEY_STORAGE_AREA, isAvailable, permissionPattern, mayUseNetwork, resolveOptIn };
})(self);
