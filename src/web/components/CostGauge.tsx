import type { PeriodCosts, StatusResponse } from '../types.js';

// Semicircular arc: M 20 105 A 80 80 0 0 1 180 105
// Arc length = π × 80 ≈ 251.327
const ARC_LEN = Math.PI * 80;

function gaugeColor(pct: number): string {
  if (pct >= 0.9) return '#ef4444';
  if (pct >= 0.7) return '#f59e0b';
  return '#22c55e';
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n >= 100 ? 2 : 4)}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// ---------------------------------------------------------------------------
// Gauge arc (SVG semicircle)
// ---------------------------------------------------------------------------

function Arc({ pct }: { pct: number }) {
  const clamped = Math.min(Math.max(pct, 0), 1);
  const color   = gaugeColor(clamped);
  const dashFill = ARC_LEN * clamped;

  return (
    <svg className="gauge-svg" viewBox="0 0 200 112" aria-hidden>
      {/* Track */}
      <path
        d="M 20 105 A 80 80 0 0 1 180 105"
        fill="none" stroke="#e2e8f0" strokeWidth="14" strokeLinecap="round"
      />
      {/* Fill */}
      <path
        d="M 20 105 A 80 80 0 0 1 180 105"
        fill="none"
        stroke={color}
        strokeWidth="14"
        strokeLinecap="round"
        strokeDasharray={`${dashFill} ${ARC_LEN}`}
      />
      {/* Centre label */}
      <text
        x="100" y="82"
        textAnchor="middle"
        fontSize="22" fontWeight="700"
        fill="currentColor"
      >
        {(clamped * 100).toFixed(1)}%
      </text>
      {/* 0 / 100% ticks */}
      <text x="18"  y="118" textAnchor="middle" fontSize="10" fill="#94a3b8">0%</text>
      <text x="182" y="118" textAnchor="middle" fontSize="10" fill="#94a3b8">100%</text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Exported component
// ---------------------------------------------------------------------------

interface Props {
  status: StatusResponse | null;
  costs: PeriodCosts | null;
}

export function CostGauge({ status, costs }: Props) {
  const limit   = status?.spendLimitUsd ?? null;
  const monthly = costs?.monthly ?? null;

  const period = status?.billingPeriod;
  const periodLabel = period
    ? `${fmtDate(period.startingAt)} – ${fmtDate(period.endingAt)}`
    : '—';

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p className="card-title">Billing period spend</p>
      <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: -12 }}>{periodLabel}</p>

      {limit !== null && monthly !== null ? (
        <div className="gauge-wrap">
          <Arc pct={monthly / limit} />
          <div className="gauge-meta">
            <div className="gauge-meta-item">
              <div className="gauge-meta-label">Spent</div>
              <div className="gauge-meta-value amount">{fmtUsd(monthly)}</div>
            </div>
            <div className="gauge-meta-item">
              <div className="gauge-meta-label">Limit</div>
              <div className="gauge-meta-value amount">{fmtUsd(limit)}</div>
            </div>
            <div className="gauge-meta-item">
              <div className="gauge-meta-label">Remaining</div>
              <div className="gauge-meta-value amount">{fmtUsd(Math.max(0, limit - monthly))}</div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ fontSize: 32, fontWeight: 700 }} className="amount">
            {monthly !== null ? fmtUsd(monthly) : '—'}
          </p>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            {monthly !== null
              ? 'No spend limit configured'
              : 'Waiting for first daemon poll…'}
          </p>
        </div>
      )}

      {/* Period breakdown */}
      {costs && (
        <div>
          {([
            ['Monthly', costs.monthly],
            ['Weekly',  costs.weekly],
            ['Daily',   costs.daily],
          ] as [string, number | null][]).map(([label, val]) => (
            <div key={label} className="period-row">
              <span className="period-name">{label}</span>
              <span className="period-value amount">
                {val !== null ? fmtUsd(val) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
