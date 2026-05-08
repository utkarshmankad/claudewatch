import nodemailer from 'nodemailer';
import type { EmailConfig } from '../config/schema.js';
import type { AlertPayload } from './types.js';

export async function sendEmailAlert(
  cfg: EmailConfig,
  password: string,
  payload: AlertPayload,
): Promise<void> {
  const transport = buildTransport(cfg, password);
  const { subject, text, html } = formatEmail(cfg, payload);
  await transport.sendMail({ from: cfg.user, to: cfg.to, subject, text, html });
}

// ---------------------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------------------

function buildTransport(cfg: EmailConfig, password: string): nodemailer.Transporter {
  if (cfg.provider === 'sendgrid') {
    // SendGrid SMTP relay — auth username is always the literal string 'apikey';
    // the password is the SendGrid API key stored in keychain.
    return nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: password },
    });
  }

  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: password },
  });
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function formatEmail(cfg: EmailConfig, p: AlertPayload): EmailContent {
  const { threshold: t, currentPct, estimatedCost, billingPeriod } = p;

  const overageUsd = (estimatedCost - t.amountUsd).toFixed(4);
  const periodFrom = formatUtcDate(billingPeriod.startingAt);
  const periodTo = formatUtcDate(billingPeriod.endingAt);

  const subject =
    `ClaudeWatch: $${estimatedCost.toFixed(2)} spent — ` +
    `$${t.amountUsd} ${t.period} threshold exceeded`;

  const text = [
    `ClaudeWatch Spend Alert`,
    ``,
    `Your ${t.period} Claude API spend has exceeded $${t.amountUsd}.`,
    ``,
    `  Current spend : $${estimatedCost.toFixed(4)}`,
    `  Threshold     : $${t.amountUsd} (${t.period})`,
    `  Overage       : $${overageUsd} (${currentPct.toFixed(1)}% of threshold)`,
    `  Billing period: ${periodFrom} → ${periodTo}`,
    ``,
    `Manage alerts: claudewatch threshold list`,
    cfg.provider === 'sendgrid'
      ? `Sent via SendGrid`
      : `Sent via ${cfg.host}`,
  ].join('\n');

  const html = buildHtml(t, currentPct, estimatedCost, overageUsd, periodFrom, periodTo);

  return { subject, text, html };
}

function buildHtml(
  t: AlertPayload['threshold'],
  currentPct: number,
  estimatedCost: number,
  overageUsd: string,
  periodFrom: string,
  periodTo: string,
): string {
  const red = '#c62828';
  const labelStyle =
    'padding:8px 14px;border:1px solid #e0e0e0;background:#fafafa;font-weight:600;white-space:nowrap';
  const valueStyle =
    'padding:8px 14px;border:1px solid #e0e0e0';
  const overageStyle =
    `padding:8px 14px;border:1px solid #e0e0e0;color:${red};font-weight:600`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.12)">

        <!-- Header -->
        <tr>
          <td style="background:${red};padding:20px 28px">
            <span style="color:#fff;font-size:18px;font-weight:700">&#9888; ClaudeWatch Spend Alert</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:24px 28px">
            <p style="margin:0 0 16px;font-size:15px;color:#333">
              Your <strong>${t.period}</strong> Claude API spend has crossed the
              <strong>$${t.amountUsd}</strong> threshold.
            </p>

            <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:20px">
              <tr>
                <td style="${labelStyle}">Current spend</td>
                <td style="${valueStyle}">$${estimatedCost.toFixed(4)}</td>
              </tr>
              <tr>
                <td style="${labelStyle}">Threshold</td>
                <td style="${valueStyle}">$${t.amountUsd} <span style="color:#757575">(${t.period})</span></td>
              </tr>
              <tr>
                <td style="${labelStyle}">Overage</td>
                <td style="${overageStyle}">$${overageUsd} &nbsp;&#8212;&nbsp; ${currentPct.toFixed(1)}% of threshold</td>
              </tr>
              <tr>
                <td style="${labelStyle}">Billing period</td>
                <td style="${valueStyle}">${periodFrom} &#8211; ${periodTo}</td>
              </tr>
            </table>

            <p style="margin:0;font-size:12px;color:#9e9e9e">
              Manage alerts: <code>claudewatch threshold list</code>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function formatUtcDate(iso: string): string {
  return new Date(iso).toUTCString().replace(' GMT', ' UTC');
}
