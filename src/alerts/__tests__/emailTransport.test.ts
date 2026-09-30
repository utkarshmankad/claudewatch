import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { sendEmailAlert } from '../email.js';
import type { EmailConfig } from '../../config/schema.js';
import type { AlertPayload } from '../types.js';

const config: EmailConfig = {
  provider: 'smtp', host: 'smtp.example.com', port: 587, secure: false,
  user: 'alerts@example.com',
  to: '"Ops, Team" <ops@example.com>, owner@example.com',
};
const payload: AlertPayload = {
  threshold: { amountUsd: 10, period: 'daily', notifyEmail: true, notifyDesktop: false },
  currentPct: 150, estimatedCost: 15,
  billingPeriod: { startingAt: '2026-09-01T00:00:00Z', endingAt: '2026-09-30T00:00:00Z' },
};

afterEach(() => { vi.restoreAllMocks(); });

describe('email alert with the installed Nodemailer transport', () => {
  it('renders the alert and parses quoted display names and multiple recipients', async () => {
    // Exercise the actual installed mail composer/address parser without SMTP traffic.
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const send = vi.spyOn(transport, 'sendMail');
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue(transport);

    await sendEmailAlert(config, 'unused-test-password', payload);

    const info = await send.mock.results[0].value;
    expect(info.envelope).toEqual({
      from: 'alerts@example.com', to: ['ops@example.com', 'owner@example.com'],
    });
    const message = info.message.toString();
    expect(message).toContain('To: "Ops, Team" <ops@example.com>, owner@example.com');
    expect(message).toContain('ClaudeWatch Spend Alert');
    expect(message).toContain('$15.0000');
    expect(message).toContain('text/plain');
    expect(message).toContain('text/html');
    expect(message).not.toContain('unused-test-password');
  });
});
