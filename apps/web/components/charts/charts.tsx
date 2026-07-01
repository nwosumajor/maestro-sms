// =============================================================================
// KPI tile — a dependency-free, server-renderable stat card on the design tokens.
// (Interactive charts live in charts/rc.tsx, built on Recharts.)
// =============================================================================

/** A big number with an optional sub-line — the KPI unit above chart panels. */
export function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-5 shadow-card">
      <p className="eyebrow">{label}</p>
      <p className="tnum mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
