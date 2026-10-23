import { createHash } from 'node:crypto';

export const sessionKey = (raw: string): string => createHash('sha256').update(`session:${raw}`).digest('hex').slice(0, 16);

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const tokenCount = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v <= 1e10 ? v : null;
export const parseTime = (v: unknown): number | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
// Model names are copied from logs; allow only identifier characters so free text cannot ride along.
export const safeModel = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(v) ? v : undefined;
