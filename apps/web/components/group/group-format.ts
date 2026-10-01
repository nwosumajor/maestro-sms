// =============================================================================
// Group console wording — shared by the overview (a client island) and the
// campus page (a server component), so a figure reads the same on both.
// Pure functions only: no hooks, nothing a server component cannot import.
// =============================================================================

import type { GroupComparisonDto, GroupMoneyDto, GroupWindowDto, Serialized } from "@sms/types";

/** A change in percentage POINTS, e.g. attendance 88% -> 91% is "+3 pts". */
export function pointsDelta(now: number | null, before: number | null): { text: string; dir: -1 | 0 | 1 } | null {
  if (now == null || before == null) return null;
  const d = now - before;
  return { text: `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} pts`, dir: d > 0 ? 1 : d < 0 ? -1 : 0 };
}

/** A relative change in money, e.g. "+12%". Null when there is nothing to compare
 *  against — a percentage of zero is not a number anybody can read. */
export function moneyDelta(nowMinor: number, beforeMinor: number): { text: string; dir: -1 | 0 | 1 } | null {
  if (beforeMinor <= 0) return null;
  const pct = Math.round(((nowMinor - beforeMinor) / beforeMinor) * 100);
  return { text: `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%`, dir: pct > 0 ? 1 : pct < 0 ? -1 : 0 };
}

/** What a campus collected over the previous window, in one currency. */
export function previousCollected(previous: Serialized<GroupComparisonDto>, currency: string): number {
  return previous.collected.find((c) => c.currency === currency)?.collectedMinor ?? 0;
}

/** Overdue as a share of what is owed — comparable across currencies. */
export function overdueShare(money: Serialized<GroupMoneyDto>[]): number | null {
  const owed = money.reduce((n, m) => n + m.outstandingMinor, 0);
  if (owed <= 0) return null;
  return Math.round((money.reduce((n, m) => n + m.overdueMinor, 0) / owed) * 100);
}

/** One sentence saying what a campus's window was built from. */
export function windowNote(w: Serialized<GroupWindowDto>, fmt: (d: string) => string): string {
  if (w.basis === "TERM") return `Term from ${fmt(w.fromDay)}`;
  if (w.basis === "NO_TERM_LAST_90_DAYS") return "No current term — last 90 days";
  return `${fmt(w.fromDay)} – ${fmt(w.toDay)}`;
}

/**
 * A coverage percentage as words. Some-but-under-half-a-percent rounds to 0, and
 * "0%" beside "2 of 589" reads as none taken; it is "<1%".
 */
export function coverageText(pct: number | null, covered: number | null): string {
  if (pct == null) return "—";
  if (pct === 0 && (covered ?? 0) > 0) return "<1%";
  return `${pct}%`;
}

/** Tailwind class for a delta, where `goodWhen` says which direction is good. */
export function deltaClass(dir: -1 | 0 | 1, goodWhen: 1 | -1 = 1): string {
  if (dir === 0) return "text-muted-foreground";
  return dir === goodWhen ? "text-emerald-600 dark:text-emerald-400" : "text-destructive";
}
