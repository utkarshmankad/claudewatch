import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import type { UsageRow } from '../types.js';

// ---------------------------------------------------------------------------
// Model → colour mapping (stable order for consistent colours)
// ---------------------------------------------------------------------------

const PALETTE = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#f97316', '#84cc16',
  '#ec4899', '#14b8a6',
];

function modelColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

function shortModel(model: string): string {
  // "claude-3-5-sonnet-20241022" → "claude-3-5-sonnet"
  return model.replace(/-\d{8}$/, '');
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Pivot flat rows → recharts dataset
// ---------------------------------------------------------------------------

interface ChartRow {
  day: string;
  [model: string]: string | number;
}

function pivotData(rows: UsageRow[]): { data: ChartRow[]; models: string[] } {
  const modelSet = new Set<string>();
  const byDay = new Map<string, ChartRow>();

  for (const r of rows) {
    const m = shortModel(r.model);
    modelSet.add(m);
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day });
    byDay.get(r.day)![m] = (byDay.get(r.day)![m] as number ?? 0) + r.tokens;
  }

  const models = [...modelSet].sort();
  const data = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  return { data, models };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  rows: UsageRow[];
  days: number;
}

export function DailyChart({ rows, days }: Props) {
  if (rows.length === 0) {
    return (
      <div className="card">
        <p className="card-title">Daily token usage by model — last {days} days</p>
        <div className="empty-state">No usage data yet — is the daemon running?</div>
      </div>
    );
  }

  const { data, models } = pivotData(rows);

  return (
    <div className="card">
      <p className="card-title">Daily token usage by model — last {days} days</p>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart
          data={data}
          margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
          barCategoryGap="20%"
        >
          <XAxis
            dataKey="day"
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={d => (d as string).slice(5)}  // MM-DD
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmtTokens}
            width={42}
          />
          <Tooltip
            contentStyle={{
              background: '#1e293b', border: 'none', borderRadius: 8,
              color: '#f8fafc', fontSize: 12,
            }}
            formatter={(value: number, name: string) => [fmtTokens(value), name]}
            labelFormatter={l => `Date: ${l}`}
            cursor={{ fill: 'rgba(99,102,241,.08)' }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
            formatter={v => shortModel(String(v))}
          />
          {models.map((model, i) => (
            <Bar
              key={model}
              dataKey={model}
              stackId="stack"
              fill={modelColor(i)}
              radius={i === models.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
            >
              {data.map(entry => (
                <Cell key={entry.day} fill={modelColor(i)} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
