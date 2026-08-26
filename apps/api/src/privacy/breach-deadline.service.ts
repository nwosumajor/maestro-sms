// =============================================================================
// A statutory clock that nobody was watching
// =============================================================================
// The breach register computes `notifyDueAt` / `hoursRemaining` / `overdue`
// from the school's own compliance regime, and does it ONLY when somebody opens
// /admin/compliance. Nothing swept, nothing warned, nothing chased.
//
// This platform runs seventeen scheduled sweeps. It reminds HR that a staff
// certificate expires in THIRTY DAYS; it chases an overdue library book, a
// boarder signed out too long, an invoice past its due date, a lapsed
// subscription, a stranded notification, an index gone bloated. The one
// deadline written in law — 72 hours from becoming aware, Art. 33(1) — had no
// sweep at all. A breach reported at 17:00 on a Friday by the only person who
// then went on leave was a missed statutory notification that the product would
// not mention until somebody happened to open a screen.
//
// Hourly, not daily, and for the reason the mobile-money sweep gives about
// itself: the window is 72 hours, so a daily sweep could first warn with four
// hours left, or discover a breach was late a day after it happened.
//
// Cross-tenant and privileged, like dunning and retention. Per school, so one
// school's failure cannot end the run — the lesson this repo has now recorded
// three times — and the failures are COUNTED into the result, because the
// operator's jobs console reads that number to decide whether a run was
// healthy, and a count nobody surfaces is a count nobody acts on.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { PRIVACY_PERMISSIONS } from "@sms/types";
import { NotificationService } from "../notifications/notification.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import { SchoolRegionService } from "../foundation/school-region.service";
import { BREACH_DEADLINE_DATABASE } from "./privacy.constants";
import { breachClock, breachNoticeStage, type BreachClockRow } from "./breach-clock";

export interface BreachDeadlineResult {
  scanned: number;
  warned: number;
  overdue: number;
  /** Schools whose sweep threw. Counted once each, whatever failed. */
  failed: number;
  skipped?: "NO_DB";
}

type Row = BreachClockRow & {
  id: string;
  schoolId: string;
  title: string;
  deadlineNoticeStage: string | null;
};

@Injectable()
export class BreachDeadlineService {
  private readonly logger = new Logger("BreachDeadline");

  constructor(
    @Inject(BREACH_DEADLINE_DATABASE) private readonly db: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
    private readonly region: SchoolRegionService,
  ) {}

  async sweep(): Promise<BreachDeadlineResult> {
    const client = this.db.client;
    if (!client) return { scanned: 0, warned: 0, overdue: 0, failed: 0, skipped: "NO_DB" };

    // Only incidents still needing an Art. 33 answer. A CLOSED one, one already
    // notified, and one with a recorded reason for not notifying are all
    // finished as far as this clock is concerned — `breachClock` says so and
    // this filter must not disagree with it, so it narrows on the same three
    // facts and lets the clock make the decision.
    const open = (await client.dataBreachIncident.findMany({
      where: { status: { not: "CLOSED" }, notifiedAuthorityAt: null, noNotificationReason: null },
      select: {
        id: true,
        schoolId: true,
        title: true,
        discoveredAt: true,
        status: true,
        riskLevel: true,
        notifiedAuthorityAt: true,
        notifiedSubjectsAt: true,
        noNotificationReason: true,
        deadlineNoticeStage: true,
      },
    })) as Row[];
    if (open.length === 0) return { scanned: 0, warned: 0, overdue: 0, failed: 0 };

    const bySchool = new Map<string, Row[]>();
    for (const r of open) bySchool.set(r.schoolId, [...(bySchool.get(r.schoolId) ?? []), r]);

    const now = new Date();
    const failedSchools = new Set<string>();
    let warned = 0;
    let overdue = 0;

    for (const [schoolId, rows] of bySchool) {
      try {
        // The school's OWN regime decides the hours, so it is read per school
        // rather than assumed — the same accessor the register itself uses.
        const regime = (await this.region.forSchool(schoolId)).compliance;
        for (const r of rows) {
          const clock = breachClock(r, now, regime);
          const stage = breachNoticeStage(r, clock);
          // Nothing to say, or the same thing already said. A notice per hour
          // is a notice people learn to ignore, including on the incident where
          // it mattered.
          if (!stage || stage === r.deadlineNoticeStage) continue;

          const deadline = clock.deadlineIsStatutory ? "statutory deadline" : "target";
          await this.notifications.notifyPermissionHolders(
            // The SYSTEM actor: no person triggered this, and attributing an
            // hourly timer to whoever last touched the record would put a name
            // on a notice they did not send.
            { schoolId, userId: SYSTEM_ACTOR_ID },
            PRIVACY_PERMISSIONS.COMPLIANCE_MANAGE,
            {
              type: "OPERATOR_ALERT",
              title:
                stage === "OVERDUE"
                  ? `Breach notification is PAST its ${deadline}`
                  : `Breach notification is due within ${clock.hoursRemaining} hour(s)`,
              body:
                stage === "OVERDUE"
                  ? `“${r.title}” has not been notified to the supervisory authority and no reason for not notifying has been recorded. Record one or the other on the compliance page.`
                  : `“${r.title}” must be notified to the supervisory authority, or a reason for not notifying recorded, by ${clock.notifyDueAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
              data: { breachIncidentId: r.id, stage },
            },
          );
          await client.dataBreachIncident.update({
            where: { id: r.id },
            data: { deadlineNoticeStage: stage },
          });
          if (stage === "OVERDUE") overdue += 1;
          else warned += 1;
        }
      } catch (e) {
        failedSchools.add(schoolId);
        // NAMED. A count says four failed and never which; the one failing
        // every hour is the one worth fixing.
        this.logger.error(`breach deadline sweep failed for school ${schoolId}: ${(e as Error).message}`);
      }
    }

    this.logger.log(
      `Breach deadline sweep: scanned=${open.length} warned=${warned} overdue=${overdue} failed=${failedSchools.size}`,
    );
    return { scanned: open.length, warned, overdue, failed: failedSchools.size };
  }
}
