import type { LedgerFilter, LedgerView, AlertsResponse, AnalyticsResponse, StatusResponse, UsageResponse } from './types.js';

const BASE = '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function ledgerQuery(filter: LedgerFilter): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') q.set(k, String(v));
  return q.toString();
}

export const api = {
  ledger: (filter: LedgerFilter = {}) => get<LedgerView>(`/ledger?${ledgerQuery(filter)}`),
  deleteLedger: async (filter: LedgerFilter): Promise<{ deleted: number }> => {
    const confirm = Object.keys(filter).length === 0 ? 'all' : 'yes';
    const res = await fetch(`${BASE}/ledger?${ledgerQuery(filter)}${Object.keys(filter).length ? '&' : ''}confirm=${confirm}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<{ deleted: number }>;
  },
  status: ()                   => get<StatusResponse>('/status'),
  usage:  (days = 30)          => get<UsageResponse>(`/usage?days=${days}`),
  alerts: (limit = 50)         => get<AlertsResponse>(`/alerts?limit=${limit}`),
  analytics: (days = 30)       => get<AnalyticsResponse>(`/analytics?days=${days}`),
};
