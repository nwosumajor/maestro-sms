// =============================================================================
// One definition of whether a school is late
// =============================================================================
// `ComplianceService.clockFor` says it plainly: letting "the record and the
// screen disagree about whether a school is late … is the single fact this
// whole register exists to establish". The hourly deadline sweep needs the same
// answer, so it is pulled out here and BOTH call it, rather than the sweep
// re-deriving 72 hours and drifting the day a regime changes.
// =============================================================================

import { breachTarget } from "@sms/types";

const HOUR_MS = 3_600_000;

export interface BreachClockRow {
  discoveredAt: Date;
  status: string;
  riskLevel: string;
  notifiedAuthorityAt: Date | null;
  notifiedSubjectsAt: Date | null;
  noNotificationReason: string | null;
}

export interface BreachClock {
  notifyDueAt: Date;
  hoursRemaining: number;
  overdue: boolean;
  subjectsUnnotified: boolean;
  deadlineIsStatutory: boolean;
}

/**
 * The deadline comes from the REGIME, not from a constant. 72 hours is the law
 * under GDPR Art. 33, Nigeria's NDPA and Kenya's DPA — but POPIA sets no fixed
 * period, and for a country whose law is not modelled here a statutory-looking
 * countdown invents a deadline. `deadlineIsStatutory` carries that distinction
 * so the same number can be shown honestly as either "your deadline" or "good
 * practice".
 */
export function breachClock(r: BreachClockRow, now: Date, regime?: string | null): BreachClock {
  const target = breachTarget(regime);
  const notifyDueAt = new Date(r.discoveredAt.getTime() + target.hours * HOUR_MS);
  const hoursRemaining = Math.round((notifyDueAt.getTime() - now.getTime()) / HOUR_MS);
  // Not notifying can be lawful — Art. 33(1) excuses it where the breach is
  // "unlikely to result in a risk". But it must be a RECORDED decision, so an
  // incident with neither a notification nor a stated reason is overdue.
  const overdue =
    !r.notifiedAuthorityAt && !r.noNotificationReason && now.getTime() > notifyDueAt.getTime() && r.status !== "CLOSED";
  // Art. 34: high risk means the people themselves must be told, not just the
  // regulator. Telling the regulator and stopping there is a common failing.
  const subjectsUnnotified = r.riskLevel === "HIGH" && !!r.notifiedAuthorityAt && !r.notifiedSubjectsAt;
  return { notifyDueAt, hoursRemaining, overdue, subjectsUnnotified, deadlineIsStatutory: target.statutory };
}

/** How long before the deadline the sweep first warns. */
export const BREACH_WARN_HOURS = 24;

/**
 * Which notice, if any, this incident is due — or null when it needs none.
 *
 * DELIBERATELY SILENT ON Art. 34. `subjectsUnnotified` is a real omission and
 * the posture screen names it, but Art. 34 says "without undue delay" and fixes
 * no hour count. Chasing it on a timer would put a deadline in a notice that
 * the law does not set, which is the mistake `deadlineIsStatutory` exists to
 * avoid one field over.
 */
export function breachNoticeStage(r: BreachClockRow, clock: BreachClock): "APPROACHING" | "OVERDUE" | null {
  if (r.status === "CLOSED") return null;
  // OUTSTANDING IS ASKED DIRECTLY, not inferred from `overdue`.
  //
  // The first version reasoned that "`overdue` is already false when the
  // authority was told or a reason was recorded, so reaching here means it is
  // still outstanding" — which is exactly backwards: `overdue` is false BOTH
  // when there is time left and when the work is done. A breach notified to the
  // regulator an hour after discovery would then have been warned about at hour
  // 48 for a duty already discharged. The sweep's own `where` happens to filter
  // those rows out, so nothing downstream would have shown it; the test that
  // calls this function directly did.
  if (r.notifiedAuthorityAt || r.noNotificationReason) return null;
  if (clock.overdue) return "OVERDUE";
  if (clock.hoursRemaining <= BREACH_WARN_HOURS) return "APPROACHING";
  return null;
}
