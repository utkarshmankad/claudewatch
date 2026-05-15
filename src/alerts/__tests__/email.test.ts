import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AlertPayload } from '../types.js';
import type { EmailConfig } from '../../config/schema.js';

const mockSendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: 'test-id' }));
const mockCreateTransport = vi.hoisted(() => vi.fn(() => ({ sendMail: mockSendMail })));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

import { sendEmailAlert } from '../email.js';

const smtpCfg: EmailConfig = {
  provider: 'smtp',
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  user: 'alerts@example.com',
  to: 'owner@example.com',
};

const sendgridCfg: EmailConfig = {
  provider: 'sendgrid',
  host: '',
  port: 587,
  secure: false,
  user: 'alerts@example.com',
  to: 'owner@example.com',
};

const payload: AlertPayload = {
  threshold: { amountUsd: 10, period: 'daily', notifyEmail: true, notifyDesktop: false },
  currentPct: 150,
  estimatedCost: 15,
  billingPeriod: { startingAt: '2024-06-01T00:00:00.000Z', endingAt: '2024-06-15T14:30:00.000Z' },
};

describe('sendEmailAlert', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates an SMTP transport with the provided config', async () => {
    await sendEmailAlert(smtpCfg, 'secret', payload);
    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'alerts@example.com', pass: 'secret' },
    }));
  });

  it('creates a SendGrid transport with fixed host and "apikey" username', async () => {
    await sendEmailAlert(sendgridCfg, 'sg-api-key', payload);
    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: 'sg-api-key' },
    }));
  });

  it('sends mail with from/to matching the config', async () => {
    await sendEmailAlert(smtpCfg, 'secret', payload);
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'alerts@example.com',
      to: 'owner@example.com',
    }));
  });

  it('subject contains the spend amount and period', async () => {
    await sendEmailAlert(smtpCfg, 'secret', payload);
    const { subject } = mockSendMail.mock.calls[0][0] as { subject: string };
    expect(subject).toContain('$15.00 spent');
    expect(subject).toContain('daily');
    expect(subject).toContain('$10');
  });

  it('text body contains spend, threshold, and billing period', async () => {
    await sendEmailAlert(smtpCfg, 'secret', payload);
    const { text } = mockSendMail.mock.calls[0][0] as { text: string };
    expect(text).toContain('$15.0000');
    expect(text).toContain('$10 (daily)');
    expect(text).toContain('150.0%');
  });

  it('html body is a non-empty HTML string', async () => {
    await sendEmailAlert(smtpCfg, 'secret', payload);
    const { html } = mockSendMail.mock.calls[0][0] as { html: string };
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('ClaudeWatch Spend Alert');
    expect(html).toContain('$10');
    expect(html).toContain('daily');
  });

  it('text shows SMTP host for smtp provider', async () => {
    await sendEmailAlert(smtpCfg, 'secret', payload);
    const { text } = mockSendMail.mock.calls[0][0] as { text: string };
    expect(text).toContain('smtp.example.com');
  });

  it('text shows SendGrid for sendgrid provider', async () => {
    await sendEmailAlert(sendgridCfg, 'sg-key', payload);
    const { text } = mockSendMail.mock.calls[0][0] as { text: string };
    expect(text).toContain('SendGrid');
  });

  it('propagates sendMail errors', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));
    await expect(sendEmailAlert(smtpCfg, 'secret', payload)).rejects.toThrow('SMTP connection refused');
  });
});
