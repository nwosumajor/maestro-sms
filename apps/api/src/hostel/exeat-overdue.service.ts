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
import { resolveRegion, schoolTimeString } from "@sms/types";

/** Who is told. The warden of that hostel is the first responder; the seniors
 *  are told too, because a late boarder is not a matter for one person. */
// Roles that are school-wide by design and get EVERY overdue alert. The
// hostel's own warden is added per exeat (see below) — a warden's authority is
// their own hostel, and this sweep used to tell all of them about every child.
const SCHOOL_WIDE_ALERT_ROLES = ["head_warden", "school_admin", "principal"];

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

    // "DUE BACK AT 18:00" IS A TIME AT THE SCHOOL, not on the server.
    //
    // This read `toISOString()` — UTC in a container — in the one sentence that
    // says when a child was expected, sent to the family AND to the staff going
    // to look for them. Its pair, the approval notice in `hostel.service`, is
    // the same instant read a second time and had the same bug.
    //
    // Resolved ONCE PER SCHOOL for the whole run rather than per notice: this
    // is a fleet sweep, the lesson the dunning and HR reminder sweeps already
    // record.
    const PLATFORM_TZ = resolveRegion({}).timezone;
    const tzOf = new Map<string, string>();
    for (const row of await client.school.findMany({
      where: { id: { in: [...bySchool.keys()] } },
      select: { id: true, country: true, timezone: true },
    })) {
      tzOf.set(row.id, resolveRegion(row).timezone);
    }

    for (const [schoolId, exeats] of bySchool) {
      try {
        const [staff, students, hostels, guardianRows] = await Promise.all([
          client.userRole.findMany({
            where: { schoolId, role: { name: { in: SCHOOL_WIDE_ALERT_ROLES } } },
            select: { userId: true },
            distinct: ["userId"],
          }),
          client.user.findMany({
            where: { id: { in: [...new Set(exeats.map((e) => e.studentId))] } },
            select: { id: true, name: true },
          }),
          // THE WARDEN OF THAT HOSTEL, not every warden in the school.
          //
          // A warden's authority is their own hostel — `assertHostelInScope`
          // enforces exactly that on every other hostel read and write, 404 for
          // anything else. This sweep was the one place that ignored it, so a
          // warden of Hostel B learned that a named child from Hostel A was
          // missing and where they had gone. Head wardens and the school office
          // are school-wide by design and still get every alert.
          client.hostel.findMany({
            where: { id: { in: [...new Set(exeats.map((e) => e.hostelId))] } },
            select: { id: true, wardenId: true },
          }),
          // THE FAMILY, who this module tells about every other step.
          //
          // Guardians are notified when an exeat is approved, when the child
          // signs out and when they sign back in — and were told nothing in the
          // one case that matters. The destination is usually home, so the
          // guardian is very often the person who knows where the child is and
          // the only one who can say "they left an hour ago" or "they are still
          // here". Silence at exactly the alarming moment is not discretion; it
          // is the school withholding the fact from the people most able to
          // resolve it.
          client.parentChild.findMany({
            where: { studentId: { in: [...new Set(exeats.map((e) => e.studentId))] } },
            select: { studentId: true, parentId: true },
          }),
        ]);
        const nameOf = new Map(students.map((s) => [s.id, s.name]));
        const wardenOf = new Map(
          (hostels as Array<{ id: string; wardenId: string | null }>).map((h) => [h.id, h.wardenId]),
        );
        const schoolWide = staff.map((s) => s.userId);
        const guardiansOf = new Map<string, string[]>();
        for (const g of guardianRows as Array<{ studentId: string; parentId: string }>) {
          guardiansOf.set(g.studentId, [...(guardiansOf.get(g.studentId) ?? []), g.parentId]);
        }
        if (schoolWide.length === 0 && hostels.every((h: { wardenId: string | null }) => !h.wardenId)) {
          // Said out loud. A school with nobody in these roles has no member of
          // staff to act, and silently dropping it would look identical to
          // "nobody is late".
          //
          // It WARNS and carries on rather than skipping the school, because
          // the families can still be told — and a school with no warden on
          // record is exactly the one where the parent finding out matters
          // most. The per-exeat check below is what decides whether there is
          // anybody at all.
          this.logger.warn(
            `school=${schoolId}: ${exeats.length} overdue boarder(s) but no head warden, administrator or hostel warden to tell`,
          );
        }

        // Only the ones somebody was actually TOLD about get marked. The bulk
        // update below used to mark every exeat in the school's batch,
        // including the ones this loop skipped for having nobody to alert —
        // so the single case where no human learned a child was missing was
        // also the case recorded as handled, and the next hour did not try
        // again. The comment three lines under the skip already said "left
        // unmarked so the next hour tries again"; the code did the opposite.
        const alertedIds: string[] = [];
        for (const e of exeats) {
          const name = nameOf.get(e.studentId) ?? "A boarder";
          // This hostel's own warden, plus everyone school-wide. Deduped: a head
          // warden who also wardens this hostel must not be told twice.
          const warden = wardenOf.get(e.hostelId);
          const staffToTell = [...new Set([...schoolWide, ...(warden ? [warden] : [])])];
          const family = guardiansOf.get(e.studentId) ?? [];
          if (staffToTell.length === 0 && family.length === 0) {
            // Say it rather than skipping quietly: this hostel has no warden,
            // the school has nobody school-wide, and the child has no guardian
            // on record — so a child is late back and there is literally nobody
            // to tell. Left UNMARKED so the next hour tries again, which is
            // what the marking below now honours.
            this.logger.warn(
              `school=${schoolId} hostel=${e.hostelId}: boarder overdue but nobody to alert`,
            );
            continue;
          }
          const dueAt = schoolTimeString(tzOf.get(schoolId) ?? PLATFORM_TZ, e.expectedReturnAt);
          const from = e.destination ? ` from ${e.destination}` : "";
          const data = { exeatId: e.id, studentId: e.studentId, hostelId: e.hostelId };
          // ESSENTIAL type, so a per-type mute cannot silence it — a late
          // boarder is not a notification anybody opts out of.
          if (staffToTell.length > 0) {
            await this.notifications.enqueueMany({ schoolId, userId: SYSTEM_ACTOR_ID }, staffToTell, {
              type: "OPERATOR_ALERT",
              title: `${name} is late back from exeat`,
              body:
                `${name} was due back at ${dueAt}${from} and has not signed in. ` +
                `Check on them, then record the return on the hostel page.`,
              data,
            });
          }
          // The family gets the same fact and a DIFFERENT instruction. Telling a
          // parent to "record the return on the hostel page" is telling them to
          // do something they cannot do; what the school needs from them is to
          // say where the child is.
          if (family.length > 0) {
            await this.notifications.enqueueMany({ schoolId, userId: SYSTEM_ACTOR_ID }, family, {
              type: "OPERATOR_ALERT",
              title: `${name} has not signed back in`,
              body:
                `${name} was due back at the hostel at ${dueAt}${from} and has not signed in. ` +
                `Please contact the school to confirm where they are.`,
              data,
            });
          }
          alertedIds.push(e.id);
          alerted += 1;
        }
        // Marked only after the alert actually went out, so a failure mid-way
        // leaves the exeat to be picked up by the next hour rather than
        // silently marked as handled.
        if (alertedIds.length > 0) {
          await client.hostelExeat.updateMany({
            where: { id: { in: alertedIds }, overdueNotifiedAt: null },
            data: { overdueNotifiedAt: now },
          });
        }
      } catch (err) {
        this.logger.error(`school=${schoolId}: overdue exeat alert failed: ${(err as Error).message}`);
      }
    }

    if (alerted > 0) this.logger.log(`alerted on ${alerted} overdue boarder(s)`);
    return { scanned: due.length, alerted };
  }
}
