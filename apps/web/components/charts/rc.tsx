"use client";

// =============================================================================
// Recharts panels, themed to the design tokens (teal --primary, cool ink).
// Client components — rendered inside server pages with serialisable props.
// Money values are passed already in MAJOR units (naira); `money` toggles a ₦
// prefix + thousands grouping in axes and tooltips.
// =============================================================================

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { RC } from "./colors";

const nfCompact = (n: number) =>
  Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`;
const fmtVal = (n: number, money?: boolean) => (money ? `₦${nfCompact(n)}` : n.toLocaleString());

// Charts measure the DOM (client-only). Render a fixed-height placeholder until
// mounted so the server HTML and first client render match exactly — no hydration
// mismatch, no client-side exception.
function useMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

function ChartFrame({ height, children }: { height: number; children: React.ReactNode }) {
  const mounted = useMounted();
  if (!mounted) return <div style={{ height }} aria-hidden />;
  return <>{children}</>;
}

function TipBox({ rows }: { rows: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-pop">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 whitespace-nowrap">
          {r.color && <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: r.color }} />}
          <span className="text-muted-foreground">{r.label}</span>
          <span className="tnum ml-auto pl-3 font-medium text-foreground">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

type Datum = Record<string, string | number>;
export type Series = { key: string; label: string; color: string; money?: boolean };

/** Multi-series area trend (growth + revenue over time). */
export function RCArea({ data, series, height = 264 }: { data: Datum[]; series: Series[]; height?: number }) {
  return (
    <ChartFrame height={height}>
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: RC.axis }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: RC.axis }} axisLine={false} tickLine={false} width={40} tickFormatter={(v) => nfCompact(Number(v))} />
        <Tooltip
          cursor={{ stroke: RC.grid }}
          content={({ active, payload, label }) =>
            active && payload && payload.length ? (
              <TipBox
                rows={[
                  { label: String(label), value: "" },
                  ...payload.map((p) => {
                    const s = series.find((x) => x.key === p.dataKey);
                    return { label: s?.label ?? String(p.dataKey), value: fmtVal(Number(p.value), s?.money), color: s?.color };
                  }),
                ]}
              />
            ) : null
          }
        />
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            stroke={s.color}
            strokeWidth={2}
            fill={`url(#g-${s.key})`}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 0 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Horizontal bar list (module adoption, top schools, funnel, pipeline). */
export function RCBars({
  data,
  color = RC.primary,
  money,
  height = 264,
}: {
  data: { label: string; value: number; color?: string }[];
  color?: string;
  money?: boolean;
  height?: number;
}) {
  return (
    <ChartFrame height={height}>
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 4 }} barCategoryGap={6}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={128}
          tick={{ fontSize: 11, fill: RC.axis }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
          content={({ active, payload }) =>
            active && payload && payload.length ? (
              <TipBox rows={[{ label: String(payload[0].payload.label), value: fmtVal(Number(payload[0].value), money), color }]} />
            ) : null
          }
        />
        <Bar dataKey="value" radius={[0, 5, 5, 0]} maxBarSize={22} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.color ?? color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Vertical columns (grade distribution, MRR by plan). */
export function RCColumns({
  data,
  money,
  height = 230,
}: {
  data: { label: string; value: number; color?: string }[];
  money?: boolean;
  height?: number;
}) {
  return (
    <ChartFrame height={height}>
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap={12}>
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: RC.axis }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: RC.axis }} axisLine={false} tickLine={false} width={44} tickFormatter={(v) => nfCompact(Number(v))} />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
          content={({ active, payload }) =>
            active && payload && payload.length ? (
              <TipBox rows={[{ label: String(payload[0].payload.label), value: fmtVal(Number(payload[0].value), money), color: payload[0].payload.color }]} />
            ) : null
          }
        />
        <Bar dataKey="value" radius={[5, 5, 0, 0]} maxBarSize={56} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.color ?? RC.primary} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Donut with a legend + centred total. */
export function RCDonut({
  data,
  height = 240,
  money,
}: {
  data: { name: string; value: number; color: string }[];
  height?: number;
  money?: boolean;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div style={{ width: height, height }} className="relative shrink-0">
        <ChartFrame height={height}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="100%" paddingAngle={2} strokeWidth={0} isAnimationActive={false}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }) =>
                  active && payload && payload.length ? (
                    <TipBox rows={[{ label: String(payload[0].name), value: fmtVal(Number(payload[0].value), money), color: (payload[0].payload as { color: string }).color }]} />
                  ) : null
                }
              />
            </PieChart>
          </ResponsiveContainer>
        </ChartFrame>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum text-xl font-semibold tracking-tight">{money ? `₦${nfCompact(total)}` : total.toLocaleString()}</span>
        </div>
      </div>
      <ul className="min-w-[8rem] flex-1 space-y-1.5 text-sm">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: d.color }} />
            <span className="text-muted-foreground">{d.name}</span>
            <span className="tnum ml-auto pl-3 font-medium">{money ? `₦${nfCompact(d.value)}` : d.value.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
