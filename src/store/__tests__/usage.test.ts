import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());
const mockPrepare = vi.hoisted(() => vi.fn(() => ({ get: mockGet })));
const mockGetDb = vi.hoisted(() => vi.fn(() => ({ prepare: mockPrepare })));

vi.mock('../db.js', () => ({
  getDb: mockGetDb,
}));

import { getTotalCostSince } from '../usage.js';

describe('getTotalCostSince', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('queries cost_snapshots with the provided since date', () => {
    mockGet.mockReturnValueOnce({ total: 0 });

    getTotalCostSince('2024-06-01T00:00:00.000Z');

    expect(mockPrepare).toHaveBeenCalledOnce();
    const sql: string = mockPrepare.mock.calls[0][0];
    expect(sql).toContain('cost_snapshots');
    expect(sql).toContain('end_time >= ?');
    expect(mockGet).toHaveBeenCalledWith('2024-06-01T00:00:00.000Z');
  });

  it('returns the total from the row', () => {
    mockGet.mockReturnValueOnce({ total: 42.5 });

    const result = getTotalCostSince('2024-06-01T00:00:00.000Z');
    expect(result).toBe(42.5);
  });

  it('returns 0 when there are no matching rows (COALESCE)', () => {
    mockGet.mockReturnValueOnce({ total: 0 });

    const result = getTotalCostSince('2024-06-15T00:00:00.000Z');
    expect(result).toBe(0);
  });

  it('forwards the exact date string to the query', () => {
    mockGet.mockReturnValueOnce({ total: 5.25 });

    getTotalCostSince('2024-01-01T00:00:00.000Z');
    expect(mockGet).toHaveBeenCalledWith('2024-01-01T00:00:00.000Z');
  });
});
