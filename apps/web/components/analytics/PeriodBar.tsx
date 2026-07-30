import Link from "next/link";
import type { AnalyticsPeriodDto, Serialized } from "@sms/types";

type Term = { id: string; name: string; isCurrent?: boolean };

/**
 * The reporting window, stated and selectable.
 *
 * Analytics had no time control at all — a hard-coded rolling 30 days that could not
 * be changed. So a principal could never ask "how was last term?", and because
 * report cards and fee figures are TERM-scoped, the attendance percentage here could
 * disagree with the one printed on the report card with nothing on screen to explain
 * why. The default is now the current term, and the window in force is always shown.
 *
 * Plain links, not a client island: each is a normal navigation that re-runs the
 * server aggregate for that window. Nothing is filtered in the browser.
 */
export function PeriodBar({
  period,
  terms,
  activeTermId,
  exportHref,
}: {
  period?: Serialized<AnalyticsPeriodDto>;
  terms: Term[];
  activeTermId?: string;
  exportHref: string;
}) {
  const chip = (active: boolean) =>
    `rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
      active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
    }`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link href="/analytics" className={chip(!activeTermId)}>
          This term
        </Link>
        {terms.map((t) => (
          <Link key={t.id} href={`/analytics?termId=${t.id}`} className={chip(activeTermId === t.id)}>
            {t.name}
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-3">
        {/* Say the window out loud. A figure with no stated period is the one that
            gets misquoted in a meeting six months later. */}
        {period && (
          <span className="text-xs text-muted-foreground">
            {period.label} · {period.from} – {period.to}
          </span>
        )}
        <a className="text-sm text-muted-foreground underline hover:text-foreground" href={exportHref}>
          CSV
        </a>
      </div>
    </div>
  );
}
