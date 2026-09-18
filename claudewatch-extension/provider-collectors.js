// Service-worker-owned provider collectors. Each collector prefers the provider
// page's authenticated MAIN world and falls back to a credentialed extension
// request so page timer throttling cannot stop account-level refreshes.
(function registerProviderCollectors(scope) {
  const executeInTab = async (urlPatterns, func, args = []) => {
    const tabs = (await chrome.tabs.query({ url: urlPatterns }))
      .filter(tab => tab.id && !tab.discarded)
      .sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    if (!tabs.length) throw Object.assign(new Error('provider_tab_missing'), { code: 'provider_tab_missing' });
    let lastError = null;
    for (const tab of tabs) {
      try {
        const rows = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func, args });
        const result = rows?.[0]?.result;
        if (!result || result.error) throw Object.assign(new Error(result?.error ?? 'provider_tab_fetch_failed'), { status: result?.status ?? 0 });
        return result.data;
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error('provider_tab_fetch_failed');
  };

  async function chatGptViaTab() {
    return executeInTab(['https://chatgpt.com/*', 'https://chat.openai.com/*'], async () => {
      try {
        const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
        if (!sessionResponse.ok) return { error: 'session_fetch_failed', status: sessionResponse.status };
        const session = await sessionResponse.json();
        if (!session?.accessToken) return { error: 'not_logged_in', status: 401 };
        const usageResponse = await fetch('/backend-api/wham/usage', {
          credentials: 'include', cache: 'no-store',
          headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' },
        });
        if (!usageResponse.ok) return { error: 'usage_fetch_failed', status: usageResponse.status };
        return { data: { usage: await usageResponse.json(), email: session.user?.email ?? null } };
      } catch (error) { return { error: error?.message ?? 'usage_fetch_failed', status: 0 }; }
    });
  }

  async function chatGptFallback() {
    let cookies = await chrome.cookies.getAll({ url: 'https://chatgpt.com' });
    if (!cookies.length) cookies = await chrome.cookies.getAll({ url: 'https://chat.openai.com' });
    if (!cookies.length) throw Object.assign(new Error('provider_cookies_missing'), { status: 401 });
    const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    const commonHeaders = { Cookie: cookieHeader, Origin: 'https://chatgpt.com', Referer: 'https://chatgpt.com/' };
    const sessionResponse = await fetch('https://chatgpt.com/api/auth/session', {
      credentials: 'include', cache: 'no-store', headers: { ...commonHeaders, Accept: 'application/json' },
    });
    if (!sessionResponse.ok) throw Object.assign(new Error('session_fetch_failed'), { status: sessionResponse.status });
    const session = await sessionResponse.json();
    if (!session?.accessToken) throw Object.assign(new Error('not_logged_in'), { status: 401 });
    const usageResponse = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      credentials: 'include', cache: 'no-store',
      headers: { ...commonHeaders, Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' },
    });
    if (!usageResponse.ok) throw Object.assign(new Error('usage_fetch_failed'), { status: usageResponse.status });
    return { usage: await usageResponse.json(), email: session.user?.email ?? null };
  }

  async function collectChatGpt() {
    try { return { site: 'chatgpt', ok: true, snapshot: await chatGptViaTab(), authPath: 'tab' }; }
    catch (tabError) {
      try { return { site: 'chatgpt', ok: true, snapshot: await chatGptFallback(), authPath: 'service_worker' }; }
      catch (error) { return { site: 'chatgpt', ok: false, error: error.message, status: error.status ?? tabError.status ?? 0, authPath: 'failed' }; }
    }
  }

  const geminiRequest = async (rpcId = 'jSf9Qc') => {
    let atToken = window.WIZ_global_data?.SNlM0e ?? '';
    if (!atToken) atToken = document.documentElement.innerHTML.match(/"SNlM0e":"([^"]+)"/)?.[1] ?? '';
    if (!atToken) return { error: 'xsrf_token_missing', status: 401 };
    const body = `f.req=${encodeURIComponent(JSON.stringify([[[rpcId, '[]', null, 'generic']]]))}&at=${encodeURIComponent(atToken)}&`;
    const response = await fetch(`/_/BardChatUi/data/batchexecute?rpcids=${rpcId}&source-path=%2Fusage&rt=c`, {
      method: 'POST', credentials: 'include', cache: 'no-store', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
    });
    if (!response.ok) return { error: 'usage_fetch_failed', status: response.status };
    const wiz = window.WIZ_global_data ?? {};
    return { data: { batchText: await response.text(), rpcId, email: wiz.oPEP7c ?? null, accountId: wiz.S06Grb ?? wiz.FdrFJe ?? wiz.oPEP7c ?? null } };
  };

  async function geminiViaTab() { return executeInTab(['https://gemini.google.com/*'], geminiRequest); }

  async function geminiFallback() {
    const pageResponse = await fetch('https://gemini.google.com/app', { credentials: 'include', cache: 'no-store' });
    if (!pageResponse.ok) throw Object.assign(new Error('gemini_page_fetch_failed'), { status: pageResponse.status });
    const html = await pageResponse.text();
    const atToken = html.match(/"SNlM0e":"([^"]+)"/)?.[1] ?? '';
    if (!atToken) throw Object.assign(new Error('xsrf_token_missing'), { status: 401 });
    const rpcId = 'jSf9Qc';
    const body = `f.req=${encodeURIComponent(JSON.stringify([[[rpcId, '[]', null, 'generic']]]))}&at=${encodeURIComponent(atToken)}&`;
    const response = await fetch(`https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=${rpcId}&source-path=%2Fusage&rt=c`, {
      method: 'POST', credentials: 'include', cache: 'no-store', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
    });
    if (!response.ok) throw Object.assign(new Error('usage_fetch_failed'), { status: response.status });
    const email = html.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
    const accountId = html.match(/"(?:S06Grb|FdrFJe)":"([^"]+)"/)?.[1] ?? email;
    return { batchText: await response.text(), rpcId, email, accountId };
  }

  async function collectGemini() {
    try { return { site: 'gemini', ok: true, snapshot: await geminiViaTab(), authPath: 'tab' }; }
    catch (tabError) {
      try { return { site: 'gemini', ok: true, snapshot: await geminiFallback(), authPath: 'service_worker' }; }
      catch (error) { return { site: 'gemini', ok: false, error: error.message, status: error.status ?? tabError.status ?? 0, authPath: 'failed' }; }
    }
  }

  scope.TokenWatcherProviders = { collectChatGpt, collectGemini };
})(self);
