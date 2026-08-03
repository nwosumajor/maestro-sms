"use client";

// =============================================================================
// CalendarHealth — what an incomplete academic year has switched off
// =============================================================================
// Setting up the year is the most consequential data entry a school does and the
// least obviously so: term dates are optional, and three safety mechanisms read
// them and fail OPEN when they are missing — the past-term register lock,
// automatic roll-over, and the term archive.
//
// So this panel leads with the CONSEQUENCE, not the omission. "First Term has no
// start date" is a shrug; "the past-term register lock is off, and anyone who can
// edit a register can change one from a term that closed months ago" is a thing
// somebody fixes this afternoon.
//
// Renders nothing when the calendar is sound.
// =============================================================================

import type { CalendarFinding } from "@sms/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export function CalendarHealth({ findings }: { findings: CalendarFinding[] }) {
  if (findings.length === 0) return null;
  const critical = findings.filter((f) => f.severity === "critical").length;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Calendar check</h2>
        {critical > 0 ? (
          <Badge variant="destructive">{critical} switching something off</Badge>
        ) : (
          <Badge variant="outline">{findings.length} to look at</Badge>
        )}
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        Term dates are optional, but several protections read them. Where a date is missing, the protection is not
        weaker — it is off.
      </p>
      <div className="space-y-2">
        {findings.map((f, i) => (
          <Alert key={`${f.title}-${i}`} variant={f.severity === "critical" ? "destructive" : "info"}>
            <AlertTitle className="text-sm">{f.title}</AlertTitle>
            <AlertDescription className="text-xs">
              {f.consequence}
              {f.subject && <span className="mt-0.5 block opacity-70">{f.subject}</span>}
            </AlertDescription>
          </Alert>
        ))}
      </div>
    </section>
  );
}
