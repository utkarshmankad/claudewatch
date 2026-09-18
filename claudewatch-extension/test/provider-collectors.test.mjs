import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let collectors;

beforeAll(async () => {
  vi.stubGlobal('self', {});
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn() },
    scripting: { executeScript: vi.fn() },
    cookies: { getAll: vi.fn() },
  });
  await import('../provider-collectors.js');
  collectors = self.TokenWatcherProviders;
});

beforeEach(() => vi.clearAllMocks());

describe('service-worker provider collectors', () => {
  it('prefers a ChatGPT tab and returns the account aggregate', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 7 }]);
    chrome.scripting.executeScript.mockResolvedValue([{ result: { data: { usage: { rate_limit: {} }, email: 'user@example.com' } } }]);
    const result = await collectors.collectChatGpt();
    expect(result.ok).toBe(true);
    expect(result.authPath).toBe('tab');
    expect(result.snapshot.email).toBe('user@example.com');
    expect(chrome.tabs.query).toHaveBeenCalledWith({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
  });

  it('tries another logged-in ChatGPT tab when the first tab cannot authenticate', async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 7, active: true }, { id: 8, active: false }]);
    chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: { error: 'not_logged_in', status: 401 } }])
      .mockResolvedValueOnce([{ result: { data: { usage: { rate_limit: {} }, email: 'second@example.com' } } }]);
    const result = await collectors.collectChatGpt();
    expect(result.ok).toBe(true);
    expect(result.snapshot.email).toBe('second@example.com');
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  it('falls back to service-worker credentials when no ChatGPT tab is open', async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.cookies.getAll.mockResolvedValue([{ name: '__Secure-session', value: 'session' }]);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: 'token', user: { email: 'user@example.com' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rate_limit: { primary_window: {} } }) }));
    const result = await collectors.collectChatGpt();
    expect(result.ok).toBe(true);
    expect(result.authPath).toBe('service_worker');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to a credentialed Gemini page and RPC request', async () => {
    chrome.tabs.query.mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '<html>"SNlM0e":"at-token" user@example.com</html>' })
      .mockResolvedValueOnce({ ok: true, text: async () => 'batch-response' }));
    const result = await collectors.collectGemini();
    expect(result.ok).toBe(true);
    expect(result.authPath).toBe('service_worker');
    expect(result.snapshot.batchText).toBe('batch-response');
  });
});
