import * as React from "react";
import { cn } from "@/lib/utils";

// =============================================================================
// PageHeader — the console's "register page" band, used at the top of every
// app page. Carries the product signature in one restrained element:
//   * the exercise-book ruled-grid texture,
//   * the red MARGIN RULE down the left edge,
//   * the Spectral display serif for the title,
//   * the double-ring surface (inner border + 3px gap + hairline outer ring —
//     the Android/Material outline language, drawn with `outline` so it never
//     shifts layout).
// `actions` sit on the band's right edge; `children` render as a full-width
// footer strip inside the band (the dashboard's KPI ledger uses it).
// =============================================================================

export const RULE_GRID: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(hsl(var(--foreground) / 0.05) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground) / 0.05) 1px, transparent 1px)",
  backgroundSize: "32px 32px",
};

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  className,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Small uppercase kicker above the title (e.g. the date on the dashboard). */
  eyebrow?: React.ReactNode;
  /** Buttons / filters rendered on the band's right edge. */
  actions?: React.ReactNode;
  className?: string;
  /** Full-width footer strip inside the band (e.g. a KPI ledger). */
  children?: React.ReactNode;
}) {
  return (
    <header
      className={cn(
        "relative grow overflow-hidden rounded-2xl border border-border/80 bg-card shadow-card outline outline-1 outline-offset-[3px] outline-border/40",
        className,
      )}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-60" style={RULE_GRID} />
      {/* The exercise book's red margin rule — decorative signature. */}
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-rule/80" />
      <div className="relative flex flex-wrap items-end justify-between gap-x-4 gap-y-3 px-5 py-4 sm:px-6 sm:py-5">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className={cn("font-display text-2xl font-semibold tracking-tight", eyebrow && "mt-1")}>{title}</h1>
          {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="relative border-t border-border/60 bg-background/60 backdrop-blur-sm">{children}</div>}
    </header>
  );
}
