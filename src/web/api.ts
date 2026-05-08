import type { AlertsResponse, StatusResponse, UsageResponse } from './types.js';

const BASE = '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  status: ()                   => get<StatusResponse>('/status'),
  usage:  (days = 30)          => get<UsageResponse>(`/usage?days=${days}`),
  alerts: (limit = 50)         => get<AlertsResponse>(`/alerts?limit=${limit}`),
};
