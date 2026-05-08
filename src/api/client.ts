import type { UsageReportResponse, CostReportResponse } from './types.js';

const BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicAdminClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async fetchUsageReport(params: {
    startTime: string;
    endTime: string;
    page?: string;
  }): Promise<UsageReportResponse> {
    return this.get<UsageReportResponse>(
      '/v1/organizations/usage_report/messages',
      { start_time: params.startTime, end_time: params.endTime, ...(params.page ? { page: params.page } : {}) },
    );
  }

  async fetchCostReport(params: {
    startTime: string;
    endTime: string;
    page?: string;
  }): Promise<CostReportResponse> {
    return this.get<CostReportResponse>(
      '/v1/organizations/cost_report',
      { start_time: params.startTime, end_time: params.endTime, ...(params.page ? { page: params.page } : {}) },
    );
  }

  private async get<T>(endpoint: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE_URL}${endpoint}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const resp = await fetch(url.toString(), {
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': this.apiKey,
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${body}`);
    }
    return resp.json() as Promise<T>;
  }
}
