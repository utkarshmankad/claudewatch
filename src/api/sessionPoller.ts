import keytar from 'keytar';
import { KEYTAR_SERVICE, SESSION_COOKIE_ACCOUNT } from '../config/schema.js';

const BASE_URL   = 'https://claude.ai';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                 + 'AppleWebKit/537.36 (KHTML, like Gecko) '
                 + 'Chrome/124.0.0.0 Safari/537.36';

export interface SessionUsage {
  tokensUsed:   number | null;
  tokenLimit:   number | null;
  resetsAt:     string | null;
  windowHours:  number;
  plan:         string | null;
  source:       'anthropic_api';
  capturedAt:   string;
  orgId:        string | null;
}

export class SessionPoller {
  private cookie: string | null = null;
  private orgId:  string | null = null;

  async init(): Promise<boolean> {
    this.cookie = await keytar.getPassword(KEYTAR_SERVICE, SESSION_COOKIE_ACCOUNT);
    if (!this.cookie) {
      console.warn('[SessionPoller] No session cookie — polling disabled. Run: claudewatch set-cookie');
      return false;
    }
    console.log('[SessionPoller] Session cookie loaded — will poll Anthropic for real usage');
    return true;
  }

  private async fetchWithAuth(path: string): Promise<unknown> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'Cookie':                     `sessionKey=${this.cookie}`,
        'User-Agent':                  USER_AGENT,
        'Accept':                     'application/json',
        'Accept-Language':            'en-US,en;q=0.9',
        'Referer':                    'https://claude.ai/',
        'anthropic-client-platform':  'web_claude_ai',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      console.error('[SessionPoller] Session cookie expired — run: claudewatch set-cookie');
      this.cookie = null;
      throw new Error('Session cookie expired');
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${path}`);
    }

    return res.json();
  }

  private async discoverOrgId(): Promise<string | null> {
    try {
      const profile = await this.fetchWithAuth('/api/account_profile') as Record<string, unknown>;
      const orgId = (profile?.['memberships'] as Array<Record<string, unknown>>)?.[0]?.['organization'] as Record<string, unknown> | undefined;
      const id = orgId?.['id']
             ?? (profile?.['organization_id'])
             ?? ((profile?.['orgs'] as Array<Record<string, unknown>>)?.[0]?.['id'])
             ?? null;
      if (id) {
        console.log(`[SessionPoller] Discovered org ID: ${String(id)}`);
        this.orgId = String(id);
      }
      return this.orgId;
    } catch (err) {
      console.warn('[SessionPoller] Could not discover org ID:', err);
      return null;
    }
  }

  async poll(): Promise<SessionUsage | null> {
    if (!this.cookie) return null;

    if (!this.orgId) {
      await this.discoverOrgId();
    }
    if (!this.orgId) return null;

    try {
      const data = await this.fetchWithAuth(
        `/api/organizations/${this.orgId}/experiences/claude_web?locale=en-US`,
      );

      const usage = this.parseUsage(data);

      if (usage) {
        console.log(
          `[SessionPoller] tokensUsed=${usage.tokensUsed ?? '?'}  ` +
          `tokenLimit=${usage.tokenLimit ?? '?'}  ` +
          `resetsAt=${usage.resetsAt ?? '?'}  (authoritative)`,
        );
      } else {
        const preview = JSON.stringify(data).slice(0, 500);
        console.warn(`[SessionPoller] Could not parse usage from response: ${preview}`);
      }

      return usage;
    } catch (err) {
      console.error('[SessionPoller] Poll failed:', err);
      return null;
    }
  }

  private parseUsage(data: unknown): SessionUsage | null {
    const found = this.deepFind(data, 0);
    if (!found) return null;

    return {
      tokensUsed:  found.tokensUsed,
      tokenLimit:  found.tokenLimit,
      resetsAt:    found.resetsAt,
      windowHours: found.windowHours ?? 5,
      plan:        found.plan,
      source:      'anthropic_api',
      capturedAt:  new Date().toISOString(),
      orgId:       this.orgId,
    };
  }

  private deepFind(obj: unknown, depth: number): {
    tokensUsed: number | null;
    tokenLimit: number | null;
    resetsAt: string | null;
    windowHours: number;
    plan: string | null;
  } | null {
    if (depth > 8 || !obj || typeof obj !== 'object') return null;

    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec);

    const tokenFields = [
      'tokens_used', 'tokensUsed', 'used', 'consumed',
      'message_count', 'messages_used', 'usage_count',
      'current_usage',
    ];
    const limitFields = [
      'tokens_limit', 'tokenLimit', 'limit', 'quota',
      'max_tokens', 'message_limit', 'messages_limit',
      'usage_limit', 'max_messages', 'token_quota',
    ];
    const resetFields = [
      'resets_at', 'resetsAt', 'reset_at', 'reset_time',
      'window_end', 'next_reset', 'expires_at',
      'window_ends_at', 'quota_reset_at', 'refresh_at',
    ];

    const usedKey  = keys.find(k => tokenFields.includes(k));
    const limitKey = keys.find(k => limitFields.includes(k));
    const resetKey = keys.find(k => resetFields.includes(k));

    if ((usedKey || limitKey) && (limitKey || resetKey)) {
      return {
        tokensUsed:  usedKey  ? Number(rec[usedKey])  : null,
        tokenLimit:  limitKey ? Number(rec[limitKey]) : null,
        resetsAt:    resetKey ? String(rec[resetKey]) : null,
        windowHours: typeof rec['window_hours'] === 'number' ? rec['window_hours']
                   : typeof rec['windowHours']  === 'number' ? rec['windowHours'] as number
                   : 5,
        plan:        typeof rec['plan'] === 'string' ? rec['plan']
                   : typeof rec['tier'] === 'string' ? rec['tier']
                   : typeof rec['subscription_tier'] === 'string' ? rec['subscription_tier'] as string
                   : null,
      };
    }

    for (const key of keys) {
      const child = rec[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          const r = this.deepFind(item, depth + 1);
          if (r) return r;
        }
      } else if (child && typeof child === 'object') {
        const r = this.deepFind(child, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }
}
