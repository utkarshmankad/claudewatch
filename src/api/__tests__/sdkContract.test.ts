import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

interface CapturedRequest {
  method: string;
  url: string;
  apiKey: string | undefined;
  body: string;
}

describe('Anthropic SDK transport contract', () => {
  let server: Server;
  let baseURL: string;
  const requests: CapturedRequest[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        apiKey: header(req, 'x-api-key'),
        body,
      });

      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/messages') {
        res.end(JSON.stringify({
          id: 'msg_contract',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }));
        return;
      }

      res.end(JSON.stringify({ data: [], has_more: false, next_page: null }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected an HTTP server port');
    }
    baseURL = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  it('sends and decodes the personal messages request used by ClaudeWatch', async () => {
    const client = new Anthropic({ apiKey: 'sk-ant-contract', baseURL, maxRetries: 0 });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(response.usage).toMatchObject({ input_tokens: 5, output_tokens: 1 });
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/v1/messages',
      apiKey: 'sk-ant-contract',
    });
    expect(JSON.parse(requests.at(-1)!.body)).toMatchObject({ max_tokens: 1 });
  });

  it('preserves the generic Admin Usage API GET contract', async () => {
    const client = new Anthropic({ apiKey: 'sk-ant-admin-contract', baseURL, maxRetries: 0 });
    const response = await client.get<{ data: unknown[]; has_more: boolean }>(
      '/v1/organizations/usage_report/messages?bucket_width=1d&group_by%5B%5D=model',
    );

    expect(response).toEqual(expect.objectContaining({ data: [], has_more: false }));
    expect(requests.at(-1)).toMatchObject({
      method: 'GET',
      apiKey: 'sk-ant-admin-contract',
    });
    expect(requests.at(-1)!.url).toContain('/v1/organizations/usage_report/messages?');
    expect(requests.at(-1)!.url).toContain('group_by%5B%5D=model');
  });
});

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
