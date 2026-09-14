// =============================================================================
// StaffDayCloseService — the sweep that makes the staff register mean something
// =============================================================================
// `summary()` counts only the rows that EXIST. A member of staff who simply
// never clocked in had no row at all, so they were neither present nor absent —
// the register said "unmarked" and the month's roll-up counted nothing. Absence
// was recorded only where a human marked each absentee by hand, which on a
// kiosk or biometric school nobody does.
//
// So the absence figure was structurally near zero, and every figure drawn from
// it — the HR analytics card, a lateness conversation, a disciplinary file —
// inherited that. The PUPIL register was given a reminder sweep and a nightly
// rollup for exactly this failure; the staff register got neither.
//
// This closes the day: past the school's own evening hour, anyone with no scan
// and no approved leave becomes ABSENT, and anyone on approved leave becomes
// ON_LEAVE.
//
// WHAT IT WILL NOT DO (Golden Rule #8's shape, applied to staff): it writes a
// STATUS, never a consequence. Nothing here docks pay, opens a case or notifies
// anybody. It marks `source: SYSTEM` so a human reading the register can always
// tell a machine's conclusion from a colleague's observation, and every run is
// audited.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import { isSchoolDay, resolveRegion, schoolTimeString } from "@sms/types";
import { STAFF_DAY_CLOSE_LOCAL_HOUR } from "./staff-day-close.constants";

export interface StaffDayCloseResult {
  /** Schools whose local clock made this the closing tick. */
  schools: number;
  /** Staff marked ABSENT — nobody scanned and no leave covers them. */
  absent: number;
  /** Staff marked ON_LEAVE from an APPROVED leave request. */
  onLeave: number;
  /**
   * Days left OPEN because somebody clocked in and never clocked out. Not a
   * failure and not an absence — it is the one thing here a human should look
   * at, and folding it into either number would hide it.
   */
  openSpans: number;
  /** Schools this run could not process. Work it FAILED, never `skipped`. */
  failed: number;
  /** Schools this tick correctly passed over (wrong hour, weekend, holiday). */
  skipped: number;
}

@Injectable()
export class StaffDayCloseService {
  private readonly logger = new Logger(StaffDayCloseService.name);

  constructor(@Inject(PrivilegedDatabaseService) private readonly db: PrivilegedDatabaseService) {}

  /**
   * `onlySchoolId` is what makes the manual trigger SCHOOL-scoped: a registrar
   * pressing the button on their own page must never sweep the fleet. The
   * catalogue declares the scope and the handler passes the caller's schoolId —
   * both halves, because a declared scope the handler ignores is the defect
   * `a-fleet-sweep-one-school-could-fire` exists for.
   */
  async run(opts: { onlySchoolId?: string; force?: boolean } = {}): Promise<StaffDayCloseResult> {
    const client = this.db.client;
    const out: StaffDayCloseResult = { schools: 0, absent: 0, onLeave: 0, openSpans: 0, failed: 0, skipped: 0 };
    if (!client) {
      this.logger.warn("Staff day close: no privileged database URL — sweep disabled.");
      return out;
    }

    const schools = (await client.school.findMany({
      where: { status: "ACTIVE", isPlatform: false, ...(opts.onlySchoolId ? { id: opts.onlySchoolId } : {}) },
      select: { id: true, name: true, country: true, timezone: true },
    })) as Array<{ id: string; name: string; country: string | null; timezone: string | null }>;

    for (const school of schools) {
      try {
        // The whole REGION, not just the zone: the school WEEK comes from the
        // country, and reading only the timezone is how a Sunday-to-Thursday
        // week gets a Friday marked absent for everybody.
        const region = resolveRegion(school);
        const local = schoolTimeString(region.timezone, new Date()); // "YYYY-MM-DD HH:mm"
        const localDate = local.slice(0, 10);
        const localHour = Number(local.slice(11, 13));
        if (!opts.force && localHour !== STAFF_DAY_CLOSE_LOCAL_HOUR) {
          out.skipped += 1;
          continue;
        }
        if (!isSchoolDay(localDate, region.schoolDays)) {
          out.skipped += 1;
          continue;
        }
        const day = new Date(`${localDate}T00:00:00.000Z`);
        const holiday = await client.schoolHoliday.findFirst({
          where: { schoolId: school.id, startDate: { lte: day }, endDate: { gte: day } },
          select: { id: true },
        });
        if (holiday) {
          out.skipped += 1;
          continue;
        }

        out.schools += 1;
        const closed = await this.closeSchoolDay(client, school.id, day);
        out.absent += closed.absent;
        out.onLeave += closed.onLeave;
        out.openSpans += closed.openSpans;
      } catch (err) {
        // ONE SCHOOL'S FAILURE MUST NOT END THE FLEET'S SWEEP — named and
        // counted, because a count nobody surfaces is a count nobody acts on.
        out.failed += 1;
        this.logger.error(`Staff day close failed for ${school.name} (${school.id}): ${String(err)}`);
      }
    }

    const line =
      `Staff day close: schools=${out.schools} absent=${out.absent} onLeave=${out.onLeave} ` +
      `openSpans=${out.openSpans} failed=${out.failed} skipped=${out.skipped}`;
    if (out.failed > 0) this.logger.warn(line);
    else this.logger.log(line);
    return out;
  }

  /** One school's day. Bounded by the staff roll, which is hundreds, not thousands. */
  private async closeSchoolDay(
    client: NonNullable<PrivilegedDatabaseService["client"]>,
    schoolId: string,
    day: Date,
  ): Promise<{ absent: number; onLeave: number; openSpans: number }> {
    const [employees, marks, leave] = await Promise.all([
      client.employee.findMany({ where: { schoolId, status: "ACTIVE" }, select: { userId: true } }) as Promise<
        Array<{ userId: string }>
      >,
      client.staffAttendance.findMany({
        where: { schoolId, date: day },
        select: { id: true, userId: true, status: true, clockInAt: true, clockOutAt: true },
      }) as Promise<Array<{ id: string; userId: string; status: string; clockInAt: Date | null; clockOutAt: Date | null }>>,
      // APPROVED only. A pending request is not permission to be away, and
      // treating it as one would let anybody excuse themselves by asking.
      client.leaveRequest.findMany({
        where: { schoolId, status: "APPROVED", startDate: { lte: day }, endDate: { gte: day } },
        select: { userId: true },
      }) as Promise<Array<{ userId: string }>>,
    ]);

    const marked = new Map(marks.map((m) => [m.userId, m]));
    const onLeaveToday = new Set(leave.map((l) => l.userId));
    let absent = 0;
    let onLeave = 0;
    let openSpans = 0;

    // ONE STATEMENT PER SCHOOL, not one per member of staff.
    //
    // This closed the day with `create` inside the loop, so a school of a hundred
    // cost a hundred round trips — and the sweep runs across the whole fleet. At
    // 5,000 schools each tick closes roughly a twenty-fourth of them, so on a day
    // nobody scanned that was ~208 schools x 100 sequential inserts per tick.
    // Measured in-database, 100 rows one at a time took 34ms against 15ms as a
    // single statement, and over the wire the gap is far wider: each `create` is
    // its own round trip where `createMany` is one.
    //
    // `skipDuplicates` because `(userId, date)` is unique and a concurrent
    // clock-in can land between the read above and this write — the scan wins,
    // which is the same rule the loop enforced by checking `marked` first.
    const rows: Array<{ userId: string; status: string; note: string }> = [];
    for (const e of employees) {
      const existing = marked.get(e.userId);
      if (existing) {
        // SOMEBODY SCANNED. The sweep never overwrites an observation — a human
        // mark or a real scan outranks anything inferred from silence. The only
        // thing worth counting here is a day that was opened and never closed.
        if (existing.clockInAt && !existing.clockOutAt) openSpans += 1;
        continue;
      }
      const status = onLeaveToday.has(e.userId) ? "ON_LEAVE" : "ABSENT";
      rows.push({
        userId: e.userId,
        status,
        note: status === "ON_LEAVE" ? "Approved leave" : "No clock-in recorded",
      });
      if (status === "ON_LEAVE") onLeave += 1;
      else absent += 1;
    }
    if (rows.length > 0) {
      const written = await client.staffAttendance.createMany({
        data: rows.map((r) => ({
          schoolId,
          userId: r.userId,
          date: day,
          status: r.status,
          source: "SYSTEM",
          markedById: SYSTEM_ACTOR_ID,
          note: r.note,
        })),
        skipDuplicates: true,
      });
      // COUNT WHAT WAS WRITTEN, not what was intended. A row skipped because
      // somebody clocked in mid-sweep is not an absence, and reporting it as one
      // would put a mark in the count that is not in the table.
      if (written.count !== rows.length) {
        const lost = rows.length - written.count;
        // Taken off ABSENT first: a clock-in landing mid-sweep is what this
        // race is, and it cannot turn an approved leave into anything else.
        const fromAbsent = Math.min(absent, lost);
        absent -= fromAbsent;
        onLeave -= lost - fromAbsent;
      }
    }

    // ONE AUDIT ROW PER SCHOOL-DAY, not per person: this writes attendance
    // records about named people on nobody's say-so but a clock's, so it must be
    // traceable — but a row per member of staff would bury the log it is meant
    // to make readable, and the per-row `source: SYSTEM` already says which
    // marks were inferred.
    //
    // Written through the PRIVILEGED client rather than `AuditLogService`, which
    // requires the request transaction it stamps impersonation from. There is no
    // request here and no actor: the caller is a clock, which is exactly what
    // SYSTEM_ACTOR_ID is for.
    if (absent > 0 || onLeave > 0) {
      await client.auditLog.create({
        data: {
          schoolId,
          actorId: SYSTEM_ACTOR_ID,
          action: "hr.attendance.dayClose",
          entity: "staff_attendance",
          entityId: schoolId,
          metadata: { date: day.toISOString().slice(0, 10), absent, onLeave, openSpans },
        },
      });
    }

    return { absent, onLeave, openSpans };
  }
}
