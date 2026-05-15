import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AlertPayload } from '../types.js';

const mockNotify = vi.hoisted(() => vi.fn());

vi.mock('node-notifier', () => ({
  default: { notify: mockNotify },
}));

import { sendDesktopAlert } from '../desktop.js';

const payload: AlertPayload = {
  threshold: { amountUsd: 10, period: 'daily', notifyEmail: false, notifyDesktop: true },
  currentPct: 150,
  estimatedCost: 15,
  billingPeriod: { startingAt: '2024-06-01T00:00:00Z', endingAt: '2024-06-15T00:00:00Z' },
};

describe('sendDesktopAlert', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls notifier.notify with a title and message', () => {
    sendDesktopAlert(payload);
    expect(mockNotify).toHaveBeenCalledOnce();
    const arg = mockNotify.mock.calls[0][0] as { title: string; message: string; sound: boolean; wait: boolean };
    expect(arg.title).toBe('ClaudeWatch: daily spend alert');
    expect(arg.message).toContain('$15.00 spent');
    expect(arg.message).toContain('150%');
    expect(arg.sound).toBe(true);
    expect(arg.wait).toBe(false);
  });

  it('formats percentage and cost correctly', () => {
    const p: AlertPayload = { ...payload, currentPct: 80.5, estimatedCost: 8.0567 };
    sendDesktopAlert(p);
    const msg = (mockNotify.mock.calls[0][0] as { message: string }).message;
    expect(msg).toContain('$8.06 spent');
    expect(msg).toContain('81%');
  });

  it('uses the correct period in the title', () => {
    const p: AlertPayload = { ...payload, threshold: { ...payload.threshold, period: 'monthly' } };
    sendDesktopAlert(p);
    const title = (mockNotify.mock.calls[0][0] as { title: string }).title;
    expect(title).toBe('ClaudeWatch: monthly spend alert');
  });
});
