import { beforeAll, describe, expect, it, vi } from 'vitest';

let S;
beforeAll(async () => {
  globalThis.self = {};
  await import('../sync-settings.js');
  S = self.TokenWatcherSyncSettings;
});

describe('sync opt-in policy', () => {
  it('is local-only by default and unavailable until the build pins an origin', () => {
    expect(S.DEFAULTS.cloudSyncEnabled).toBe(false);
    expect(S.SYNC_ORIGIN).toBeNull();
    expect(S.isAvailable()).toBe(false);
    expect(S.permissionPattern()).toBeNull();
  });
  it('accepts only a bare https origin', () => {
    for (const bad of ['http://sync.example', 'https://*.example', 'https://sync.example/path', '', null, undefined]) expect(S.isAvailable(bad)).toBe(false);
    expect(S.isAvailable('https://sync.example')).toBe(true);
    expect(S.permissionPattern('https://sync.example')).toBe('https://sync.example/*');
  });
  it('allows network use only when enabled, granted and pinned', () => {
    const o = 'https://sync.example';
    expect(S.mayUseNetwork({ cloudSyncEnabled: true }, true, o)).toBe(true);
    expect(S.mayUseNetwork({ cloudSyncEnabled: true }, false, o)).toBe(false);
    expect(S.mayUseNetwork({ cloudSyncEnabled: false }, true, o)).toBe(false);
    expect(S.mayUseNetwork({ cloudSyncEnabled: true }, true)).toBe(false);
    expect(S.mayUseNetwork(undefined, true, o)).toBe(false);
  });
  it('forces local-only when the permission is denied or no origin is pinned', () => {
    expect(S.resolveOptIn(true, false, 'https://sync.example')).toEqual({ cloudSyncEnabled: false });
    expect(S.resolveOptIn(true, true)).toEqual({ cloudSyncEnabled: false });
    expect(S.resolveOptIn(true, true, 'https://sync.example')).toEqual({ cloudSyncEnabled: true });
  });
  it('local-only mode makes no fetch calls', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    if (S.mayUseNetwork(S.DEFAULTS, true, 'https://sync.example')) fetchSpy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('keeps device keys out of chrome.storage.sync', () => {
    expect(S.KEY_STORAGE_AREA).toBe('local');
  });
});
