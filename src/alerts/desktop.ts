import notifier from 'node-notifier';
import type { AlertPayload } from './types.js';

export function sendDesktopAlert(payload: AlertPayload): void {
  const { threshold: t, currentPct, estimatedCost } = payload;

  const title = `ClaudeWatch: ${t.period} spend alert`;
  const message =
    `$${estimatedCost.toFixed(2)} spent — ` +
    `${currentPct.toFixed(0)}% of $${t.amountUsd} ${t.period} threshold`;

  notifier.notify({ title, message, sound: true, wait: false });
}
