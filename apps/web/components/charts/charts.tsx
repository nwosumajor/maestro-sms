// =============================================================================
// KPI tile — a dependency-free, server-renderable stat card on the design tokens.
// (Interactive charts live in charts/rc.tsx, built on Recharts.)
// =============================================================================

/** A big number with an optional sub-line — the KPI unit above chart panels.
 *  The numeral speaks in the register serif (Spectral, tabular figures) with a
 *  short red margin-rule tick under the label — the ledger signature. */
export function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-5 shadow-card">
      <p className="eyebrow">{label}</p>
      <span aria-hidden className="mt-1.5 block h-px w-6 bg-rule/70" />
      <p className="tnum mt-2 font-display text-[1.7rem] font-semibold leading-none tracking-tight">{value}</p>
      {sub && <p className="mt-1.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
