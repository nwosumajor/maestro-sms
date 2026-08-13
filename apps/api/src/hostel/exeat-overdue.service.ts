// =============================================================================
// A boarder who is late back
// =============================================================================
// This is the thing an exeat register exists to notice. The register recorded
// who was out, where they had gone and when they were due; it told the guardians
// at approval time. Then nothing ever read `expectedReturnAt` again — no sweep,
// no flag, no alert, nothing in the UI. A child due back at six who did not
// arrive produced no signal whatsoever. The school found out when somebody
// happened to look at the right row.
//
// Two halves, because one without the other is not enough:
//
//   VISIBLE — `overdue` is computed on every exeat read (hostel.service.ts), so
//   the list is right the moment somebody looks at it.
//
//   PUSHED — this sweep, because safeguarding cannot depend on somebody
//   choosing to open a page. It alerts the people responsible for that hostel.
//
// HOURLY, not daily. A daily sweep would tell a warden at 2am that a child was
// due back at 6pm — useless as an alert and worse than none, because it looks
// like coverage. The window that matters is the hour after they were due.
//
// ONCE per exeat, not once per hour: `overdueNotifiedAt` marks it, and the mark
// is cleared on return so a second late return alerts again. An alert that
// repeats every hour until someone acts trains people to dismiss it.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { NotificationService } from "../notifications/notification.service";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";

/** Who is told. The warden of that hostel is the first responder; the seniors
 *  are told too, because a late boarder is not a matter for one person. */
const ALERT_ROLES = ["warden", "head_warden", "school_admin", "principal"];

export interface OverdueSweepResult {
  scanned: number;
  alerted: number;
  skipped?: "NO_DB";
}

@Injectable()
export class ExeatOverdueService {
  private readonly logger = new Logger("ExeatOverdue");

  constructor(
    @Inject(PrivilegedDatabaseService) private readonly db: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Alert on every boarder who is still out past their expected return.
   *
   * Cross-tenant and privileged, like the dunning and staff-document sweeps: it
   * has to run for every school without a request to hang off.
   */
  async sweep(now = new Date()): Promise<OverdueSweepResult> {
    const client = this.db.client;
    if (!client) return { scanned: 0, alerted: 0, skipped: "NO_DB" };

    const due = await client.hostelExeat.findMany({
      where: {
        status: "DEPARTED",
        actualReturnAt: null,
        expectedReturnAt: { lt: now },
        overdueNotifiedAt: null,
      },
      select: {
        id: true,
        schoolId: true,
        hostelId: true,
        studentId: true,
        destination: true,
        expectedReturnAt: true,
      },
    });
    if (due.length === 0) return { scanned: 0, alerted: 0 };

    let alerted = 0;
    // Grouped by school so one school's failure cannot stop another's alert —
    // the same isolation the dunning sweep keeps.
    const bySchool = new Map<string, typeof due>();
    for (const e of due) bySchool.set(e.schoolId, [...(bySchool.get(e.schoolId) ?? []), e]);

    for (const [schoolId, exeats] of bySchool) {
      try {
        const [staff, students] = await Promise.all([
          client.userRole.findMany({
            where: { schoolId, role: { name: { in: ALERT_ROLES } } },
            select: { userId: true },
            distinct: ["userId"],
          }),
          client.user.findMany({
            where: { id: { in: [...new Set(exeats.map((e) => e.studentId))] } },
            select: { id: true, name: true },
          }),
        ]);
        const nameOf = new Map(students.map((s) => [s.id, s.name]));
        const recipients = staff.map((s) => s.userId);
        if (recipients.length === 0) {
          // Said out loud. A school with nobody in these roles gets no alert,
          // and silently dropping it would look identical to "nobody is late".
          this.logger.warn(`school=${schoolId}: ${exeats.length} overdue boarder(s) but no warden or admin to tell`);
          continue;
        }

        for (const e of exeats) {
          const name = nameOf.get(e.studentId) ?? "A boarder";
          const dueAt = e.expectedReturnAt.toISOString().slice(0, 16).replace("T", " ");
          await this.notifications.enqueueMany(
            { schoolId, userId: SYSTEM_ACTOR_ID },
            recipients,
            {
              // ESSENTIAL, so a per-type mute cannot silence it — a late
              // boarder is not a notification anybody opts out of.
              type: "OPERATOR_ALERT",
              title: `${name} is late back from exeat`,
              body:
                `${name} was due back at ${dueAt}` +
                (e.destination ? ` from ${e.destination}` : "") +
                ` and has not signed in. Check on them, then record the return on the hostel page.`,
              data: { exeatId: e.id, studentId: e.studentId, hostelId: e.hostelId },
            },
          );
          alerted += 1;
        }
        // Marked only after the alert actually went out, so a failure mid-way
        // leaves the exeat to be picked up by the next hour rather than
        // silently marked as handled.
        await client.hostelExeat.updateMany({
          where: { id: { in: exeats.map((e) => e.id) }, overdueNotifiedAt: null },
          data: { overdueNotifiedAt: now },
        });
      } catch (err) {
        this.logger.error(`school=${schoolId}: overdue exeat alert failed: ${(err as Error).message}`);
      }
    }

    if (alerted > 0) this.logger.log(`alerted on ${alerted} overdue boarder(s)`);
    return { scanned: due.length, alerted };
  }
}
