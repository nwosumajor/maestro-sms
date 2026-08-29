"use client";

// =============================================================================
// CalendarTimeline — the school year as a shape, not a column of date inputs
// =============================================================================
// The editor below this shows every term as a row of two date fields. That is
// fine for typing and useless for CHECKING: you cannot see where today falls,
// whether two terms leave a hole between them, or which term is the one missing
// its dates — and those are exactly the mistakes that silently switch off the
// register lock and the archive.
//
// So this draws the year. Each term is a bar placed by its real dates against a
// shared scale, today is a line through it, and a term with no dates is not
// drawn at all — it is listed underneath as unplaced, which is the honest
// rendering: an undated term genuinely occupies no part of the year.
//
// Read-only by design. Editing stays in one place below; two ways to change the
// same date is how the two disagree.
// =============================================================================

import type { Serialized, AcademicSessionDto } from "@sms/types";
import { shortDate, type DisplayRegion } from "@/lib/format";
import { useFormat } from "@/components/shell/RegionProvider";
import { Badge } from "@/components/ui/badge";

type Session = Serialized<AcademicSessionDto>;

const DAY = 86_400_000;
const day = (d: unknown): number | null => {
  if (!d) return null;
  const t = new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getTime();
  return Number.isFinite(t) ? t : null;
};
// Region threaded in: a module-scope helper cannot call a hook.
const fmt = (ms: number, region: DisplayRegion) => shortDate(new Date(ms), region);

/** A rotating palette so adjacent terms are distinguishable without meaning
 *  anything — colour here is for telling bars apart, never for status. */
const BAR = ["bg-primary/70", "bg-primary/50", "bg-primary/85", "bg-primary/35"];

export function CalendarTimeline({ sessions }: { sessions: Session[] }) {
  // Dates follow the SCHOOL's calendar, not the browser's.
  const { region } = useFormat();
  const today = Date.now();

  // Only sessions with at least one dated term can be drawn.
  const drawable = sessions
    .map((s) => {
      const terms = s.terms
        .map((t) => ({ ...t, s: day(t.startDate), e: day(t.endDate) }))
        .filter((t) => t.s !== null && t.e !== null) as Array<
        Session["terms"][number] & { s: number; e: number }
      >;
      const undated = s.terms.filter((t) => !day(t.startDate) || !day(t.endDate));
      if (terms.length === 0) return { session: s, terms, undated, from: 0, to: 0 };
      // Scale to the SESSION window when it is set, else to its terms — so two
      // sessions are not silently drawn at different scales.
      const from = day(s.startDate) ?? Math.min(...terms.map((t) => t.s));
      const to = day(s.endDate) ?? Math.max(...terms.map((t) => t.e));
      return { session: s, terms, undated, from, to: Math.max(to, from + DAY) };
    })
    .filter((x) => x.terms.length > 0 || x.undated.length > 0);

  if (drawable.length === 0) return null;

  return (
    <div className="space-y-4">
      {drawable.map(({ session: s, terms, undated, from, to }) => {
        const span = to - from || DAY;
        const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - from) / span) * 100));
        const todayIn = today >= from && today <= to;

        return (
          <div key={s.id} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium">{s.name}</span>
              {s.isCurrent && <Badge variant="secondary">current</Badge>}
              {terms.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {fmt(from, region)} – {fmt(to, region)}
                </span>
              )}
            </div>

            {terms.length > 0 && (
              <div className="relative h-9 w-full overflow-hidden rounded-md border border-border bg-muted/30">
                {terms.map((t, i) => {
                  const left = pct(t.s);
                  const width = Math.max(1.5, pct(t.e) - left);
                  return (
                    <div
                      key={t.id}
                      className={`absolute inset-y-0 flex items-center justify-center overflow-hidden ${BAR[i % BAR.length]} ${
                        t.isCurrent ? "ring-2 ring-inset ring-foreground/40" : ""
                      }`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      title={`${t.name}: ${fmt(t.s, region)} – ${fmt(t.e, region)}`}
                    >
                      <span className="truncate px-1 text-[11px] font-medium text-primary-foreground">{t.name}</span>
                    </div>
                  );
                })}

                {/* Today. The single most useful mark on the whole strip: it is
                    how you see at a glance that the "current" term is not the
                    one you are actually in. */}
                {todayIn && (
                  <div
                    className="pointer-events-none absolute inset-y-0 w-0.5 bg-destructive"
                    style={{ left: `${pct(today)}%` }}
                    title="Today"
                  />
                )}
              </div>
            )}

            {/* Terms that occupy no part of the year, said plainly. These are the
                ones switching protections off. */}
            {undated.length > 0 && (
              <p className="text-xs text-destructive">
                Not on the calendar (no dates):{" "}
                {undated.map((t) => t.name).join(", ")} — set their dates below.
              </p>
            )}
          </div>
        );
      })}

      <p className="text-xs text-muted-foreground">
        Bars are drawn from each term&rsquo;s real dates. The red line is today; the outlined bar is the term marked
        current. If those two are not the same, the school is pointing at the wrong term.
      </p>
    </div>
  );
}
