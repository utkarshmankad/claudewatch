// Pure renderer for the companion: view model in, node tree out. The page turns the tree into DOM with textContent
// only (companion/app.js), so no value from the view model is ever parsed as HTML.
import type { CompanionView } from './viewModel.js';

export interface UiNode { tag: 'section' | 'h2' | 'p' | 'ul' | 'li' | 'span' | 'div'; text?: string; attrs?: Record<string, string>; children?: UiNode[] }

const pad = (n: number) => String(n).padStart(2, '0');
const when = (ms: number | null): string => {
  if (ms === null) return 'unknown';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};
const minutes = (m: number): string => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

const node = (tag: UiNode['tag'], text: string | undefined, attrs?: Record<string, string>, children?: UiNode[]): UiNode => ({
  tag, ...(text !== undefined ? { text } : {}), ...(attrs ? { attrs } : {}), ...(children ? { children } : {}),
});

const WINDOW_LABEL: Record<string, string> = { five_hour: '5-hour', weekly: 'Weekly', daily: 'Daily' };
const RISK_LABEL: Record<string, string> = { none: 'On track', watch: 'Watch', high: 'High risk' };

export function renderView(view: CompanionView | null): UiNode[] {
  if (!view) {
    return [node('section', undefined, { 'aria-labelledby': 'h-empty' }, [
      node('h2', 'Not connected', { id: 'h-empty' }),
      node('p', 'Pair this companion with a ClaudeWatch device to see quotas and receive alerts. Nothing is sent until you opt in to sync.'),
    ])];
  }
  const freshness = view.sync.freshness === 'never' ? 'Never synced' : `${view.sync.freshness === 'stale' ? 'Stale: last synced' : 'Synced'} ${when(view.sync.lastSyncAt)}`;
  const out: UiNode[] = [node('p', freshness, { role: 'status', class: `sync-${view.sync.freshness}` })];

  out.push(node('section', undefined, { 'aria-labelledby': 'h-quotas' }, [
    node('h2', 'Quotas', { id: 'h-quotas' }),
    view.quotas.length === 0
      ? node('p', 'No provider readings yet.')
      : node('ul', undefined, undefined, view.quotas.map((q) => node('li', undefined, { class: `risk-${q.risk}` }, [
        node('span', `${q.provider} (${q.accountAlias}) ${WINDOW_LABEL[q.window] ?? q.window}`),
        node('span', q.usedPercent === null ? ' no reading' : ` ${Math.round(q.usedPercent)}% used`),
        node('span', ` resets ${when(q.resetAt)}`),
        node('span', ` ${RISK_LABEL[q.risk] ?? q.risk}${q.state === 'stale' ? ' (stale reading)' : ''}`),
      ]))),
  ]));

  const rec = view.recommendation;
  out.push(node('section', undefined, { 'aria-labelledby': 'h-rec' }, [
    node('h2', 'Recommendation', { id: 'h-rec' }),
    node('p', rec ? rec.summary : 'No recommendation yet.'),
  ]));

  out.push(node('section', undefined, { 'aria-labelledby': 'h-dev' }, [
    node('h2', 'Devices', { id: 'h-dev' }),
    node('ul', undefined, undefined, view.devices.map((d) => node('li', `${d.name}${d.current ? ' (this device)' : ''}: ${d.health === 'ok' ? 'healthy' : d.health}, seen ${when(d.lastSeenAt)}`))),
  ]));

  const n = view.notifications;
  out.push(node('section', undefined, { 'aria-labelledby': 'h-notif' }, [
    node('h2', 'Notifications', { id: 'h-notif' }),
    node('p', `Frequency: ${n.alertFrequency}`),
    node('p', n.quietHours ? `Quiet hours: ${minutes(n.quietHours.startMinute)} to ${minutes(n.quietHours.endMinute)}` : 'Quiet hours: off'),
    node('p', n.mutedProviders.length ? `Muted: ${n.mutedProviders.join(', ')}` : 'No providers muted'),
  ]));
  return out;
}
