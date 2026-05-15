import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicAdminClient } from '../client.js';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResp(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('AnthropicAdminClient', () => {
  let client: AnthropicAdminClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AnthropicAdminClient('sk-admin-test');
  });

  describe('fetchUsageReport', () => {
    it('calls the correct endpoint with required params', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp({ data: [], has_more: false, next_page: null }));

      await client.fetchUsageReport({ startTime: '2024-06-01T00:00:00Z', endTime: '2024-06-15T00:00:00Z' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/v1/organizations/usage_report/messages');
      expect(url).toContain('start_time=2024-06-01T00%3A00%3A00Z');
      expect(url).toContain('end_time=2024-06-15T00%3A00%3A00Z');
      expect((opts.headers as Record<string, string>)['x-api-key']).toBe('sk-admin-test');
      expect((opts.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    });

    it('includes page param when provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp({ data: [], has_more: false, next_page: null }));

      await client.fetchUsageReport({ startTime: '2024-06-01T00:00:00Z', endTime: '2024-06-15T00:00:00Z', page: 'tok_abc' });

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('page=tok_abc');
    });

    it('returns the parsed JSON body', async () => {
      const body = { data: [{ model: 'claude-3', tokens: 100 }], has_more: false, next_page: null };
      mockFetch.mockResolvedValueOnce(jsonResp(body));

      const result = await client.fetchUsageReport({ startTime: '2024-06-01T00:00:00Z', endTime: '2024-06-15T00:00:00Z' });
      expect(result).toEqual(body);
    });
  });

  describe('fetchCostReport', () => {
    it('calls the correct endpoint', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp({ data: [], has_more: false, next_page: null }));

      await client.fetchCostReport({ startTime: '2024-06-01T00:00:00Z', endTime: '2024-06-15T00:00:00Z' });

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/v1/organizations/cost_report');
    });

    it('includes page param when provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp({ data: [], has_more: false, next_page: null }));

      await client.fetchCostReport({ startTime: '2024-06-01T00:00:00Z', endTime: '2024-06-15T00:00:00Z', page: 'p2' });

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('page=p2');
    });
  });

  describe('error handling', () => {
    it('throws with status code and body on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(
        client.fetchUsageReport({ startTime: '2024-06-01T00:00:00Z', endTime: '2024-06-15T00:00:00Z' }),
      ).rejects.toThrow('Anthropic API 401: Unauthorized');
    });

    it('propagates network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(
        client.fetchCostReport({ startTime: '2024-06-01T00:00:00Z', endTime: '2024-06-15T00:00:00Z' }),
      ).rejects.toThrow('ECONNREFUSED');
    });
  });
});
