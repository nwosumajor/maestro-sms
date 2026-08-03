// =============================================================================
// Calendar health — what a half-configured academic year silently switches off
// =============================================================================
// Setting up the year is the most consequential data entry a school does, and
// the least obviously so. Term dates are OPTIONAL in the schema, every date rule
// is "only enforced when both ends are dated", and three separate safety
// mechanisms read those dates and FAIL OPEN when they are missing:
//
//   • The past-term register lock. `markAttendance` reads the current term's
//     startDate; if it is null the lock is skipped entirely and registers from
//     any closed term become editable again. The control that makes attendance
//     evidential is the one a missing date removes.
//   • Automatic term roll-over. `termHasElapsed` returns false without an
//     endDate, so the school never advances and every "current term" report
//     keeps describing last term.
//   • The term archive sweep, which selects on `endDate IS NOT NULL`. An undated
//     term is never archived — so the year you most need in a records request is
//     the one that was never captured.
//
// None of that announces itself. Everything keeps working; it just stops
// protecting anything. That is the ambiguity worth removing: not whether a
// single term is valid — the per-term rules are already strict — but whether the
// calendar AS A WHOLE is complete enough for the things that depend on it.
//
// This is a pure assessment. It changes nothing and refuses nothing: a school
// mid-setup must be allowed to have an incomplete calendar. It states, in the
// school's own terms, what is missing and what that missing thing has turned off.
// =============================================================================

export type CalendarSeverity = "critical" | "warning" | "info";

export interface CalendarFinding {
  severity: CalendarSeverity;
  /** What is wrong, in a sentence a head teacher can act on. */
  title: string;
  /** What this has ACTUALLY disabled. The whole value of the check. */
  consequence: string;
  /** The term or session at fault, when one thing is. */
  subject?: string;
}

export interface CalendarTermInput {
  id: string;
  name: string;
  sequence: number;
  isCurrent: boolean;
  startDate: string | Date | null;
  endDate: string | Date | null;
}

export interface CalendarSessionInput {
  id: string;
  name: string;
  isCurrent: boolean;
  startDate: string | Date | null;
  endDate: string | Date | null;
  terms: CalendarTermInput[];
}

const day = (d: string | Date | null | undefined): number | null => {
  if (!d) return null;
  const t = typeof d === "string" ? new Date(`${d.slice(0, 10)}T00:00:00Z`) : new Date(d);
  const ms = t.getTime();
  return Number.isFinite(ms) ? ms : null;
};
const DAY_MS = 86_400_000;
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Assess a school's calendar.
 *
 * Ordered most-consequential first, because a list that opens with a cosmetic
 * gap while the register lock is off will be read as cosmetic.
 */
export function assessCalendar(sessions: CalendarSessionInput[], now: Date = new Date()): CalendarFinding[] {
  const out: CalendarFinding[] = [];

  if (sessions.length === 0) {
    return [
      {
        severity: "critical",
        title: "No academic session has been created.",
        consequence:
          "Terms, report cards, promotion and the past-term register lock all hang off a session. Until one exists, none of them can work.",
      },
    ];
  }

  const current = sessions.filter((s) => s.isCurrent);
  if (current.length === 0) {
    out.push({
      severity: "critical",
      title: "No session is marked as the current one.",
      consequence:
        "Nothing knows which year 'now' belongs to, so report cards and progression cannot tell this year's data from last year's.",
    });
  } else if (current.length > 1) {
    out.push({
      severity: "critical",
      title: `${current.length} sessions are marked current at once.`,
      consequence: "Which year a new record belongs to becomes arbitrary — whichever row is read first wins.",
      subject: current.map((s) => s.name).join(", "),
    });
  }

  const allTerms = sessions.flatMap((s) => s.terms);
  const currentTerms = allTerms.filter((t) => t.isCurrent);

  if (allTerms.length === 0) {
    out.push({
      severity: "critical",
      title: "The session has no terms.",
      consequence: "Attendance, grading and report cards are all scoped to a term. With none, they have nothing to scope to.",
    });
  } else if (currentTerms.length === 0) {
    out.push({
      severity: "critical",
      title: "No term is marked as the current one.",
      consequence:
        "The past-term register lock is OFF — registers from closed terms can be edited — and nothing rolls the school forward automatically.",
    });
  } else if (currentTerms.length > 1) {
    out.push({
      severity: "critical",
      title: `${currentTerms.length} terms are marked current at once.`,
      consequence: "Which term a register or a mark belongs to becomes arbitrary.",
      subject: currentTerms.map((t) => t.name).join(", "),
    });
  }

  // THE ONE THAT MATTERS MOST: the current term's dates drive the lock and the
  // roll-over, and their absence is completely silent.
  for (const t of currentTerms) {
    if (day(t.startDate) === null) {
      out.push({
        severity: "critical",
        title: `The current term "${t.name}" has no start date.`,
        consequence:
          "The past-term register lock is OFF. Anyone who can edit a register can change one from a term that closed months ago, and nothing records that the term had ended.",
        subject: t.name,
      });
    }
    if (day(t.endDate) === null) {
      out.push({
        severity: "warning",
        title: `The current term "${t.name}" has no end date.`,
        consequence:
          "The school will never roll into the next term on its own, and this term will never be archived — so it cannot be produced for a records request later.",
        subject: t.name,
      });
    }
  }

  // THE MID-YEAR MISMATCH: the pointer says one term, the date says another.
  //
  // A school that joins in February and creates a standard session is pointed at
  // whichever term the creator picked. If that is not the term they are actually
  // sitting in, nothing complains — but the past-term register lock uses the
  // WRONG term's start date, every register and mark files against the wrong
  // term, and report cards are headed with it. The timeline draws this (today's
  // line falls outside the outlined bar); this states it in words, because the
  // drawing only helps someone already looking at the calendar.
  const todayMs = day(now);
  if (currentTerms.length === 1 && todayMs !== null) {
    const cur = currentTerms[0];
    const cs = day(cur.startDate);
    const ce = day(cur.endDate);
    if (cs !== null && ce !== null && (todayMs < cs || todayMs > ce)) {
      const holding = allTerms.find(
        (t) => t.id !== cur.id && day(t.startDate) !== null && day(t.endDate) !== null && todayMs >= day(t.startDate)! && todayMs <= day(t.endDate)!,
      );
      if (holding) {
        out.push({
          severity: "critical",
          title: `Today falls in "${holding.name}", but the school is pointed at "${cur.name}".`,
          consequence:
            "Registers and marks entered now are filed against the wrong term, report cards are headed with it, and the past-term register lock is using the wrong window. Use \u201cSync to today\u201d to correct the pointer.",
          subject: holding.name,
        });
      } else if (todayMs > ce) {
        out.push({
          severity: "warning",
          title: `"${cur.name}" ended on ${fmt(ce)} and the school has not moved on.`,
          consequence:
            "No later term covers today, so nothing could roll forward. Add the next term's dates, or the school stays in a term that has finished.",
          subject: cur.name,
        });
      }
    }
  }

  // Any other undated term: quieter, but the same archival consequence.
  const undated = allTerms.filter((t) => !t.isCurrent && (day(t.startDate) === null || day(t.endDate) === null));
  if (undated.length > 0) {
    out.push({
      severity: "warning",
      title: `${undated.length} term${undated.length === 1 ? " has" : "s have"} incomplete dates.`,
      consequence:
        "An undated term is never archived and cannot scope a report card's attendance figures, so those terms are invisible to anything asked about them later.",
      subject: undated.map((t) => t.name).join(", "),
    });
  }

  // Gaps: a school day that belongs to no term. Report-card windows are
  // inclusive date ranges, so a day in no term is counted by nothing.
  for (const s of sessions) {
    const dated = s.terms
      .filter((t) => day(t.startDate) !== null && day(t.endDate) !== null)
      .sort((a, b) => (day(a.startDate) ?? 0) - (day(b.startDate) ?? 0));
    for (let i = 1; i < dated.length; i++) {
      const prevEnd = day(dated[i - 1].endDate)!;
      const nextStart = day(dated[i].startDate)!;
      const gapDays = Math.round((nextStart - prevEnd) / DAY_MS) - 1;
      // One clear day between terms is a boundary, not a gap — the validator
      // requires terms not to share a day. More than a fortnight is a holiday.
      // Anything between is likely a typo.
      if (gapDays > 1 && gapDays < 14) {
        out.push({
          severity: "info",
          title: `${gapDays} days fall between "${dated[i - 1].name}" and "${dated[i].name}".`,
          consequence:
            "Attendance taken on those days belongs to no term, so it is counted in no report card. Fine if it is a holiday; a typo if it is not.",
          subject: `${fmt(prevEnd)} → ${fmt(nextStart)}`,
        });
      }
    }
  }

  const order = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** True when nothing critical is outstanding — the calendar can be relied on. */
export function calendarIsSound(findings: CalendarFinding[]): boolean {
  return !findings.some((f) => f.severity === "critical");
}

// -----------------------------------------------------------------------------
// The one state that is refused rather than warned about
// -----------------------------------------------------------------------------
// Everything above is advisory: a school mid-setup is legitimately incomplete.
// This is the exception, because it is the state where failing open costs the
// past-term register lock — the control that makes attendance evidential.
//
// Enforced at the point a term BECOMES current, and at the point its dates would
// be cleared WHILE current. Deliberately NOT enforced retroactively: a school
// already sitting in this state must not be locked out of its own calendar
// while fixing it. They keep the warning; they cannot make it worse.

/** Why a term may not be made (or remain) the current one. Null when it may. */
export function currentTermBlocker(term: {
  name: string;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
}): string | null {
  const missing: string[] = [];
  if (!term.startDate) missing.push("start");
  if (!term.endDate) missing.push("end");
  if (missing.length === 0) return null;
  return (
    `"${term.name}" needs ${missing.join(" and ")} ${missing.length === 1 ? "date" : "dates"} before it can be the current term. ` +
    `Without a start date the past-term register lock is off, so closed terms stay editable; ` +
    `without an end date the school never rolls forward on its own and the term is never archived.`
  );
}
