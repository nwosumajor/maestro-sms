// =============================================================================
// The register nobody took, and nobody was told about
// =============================================================================
// A school's attendance register is its record that a child arrived. When one is
// never taken, an unrecorded absence is indistinguishable from a pupil who was
// present — and after `STALE_REGISTER_DAYS` the only way to correct it is a
// maker-checker amendment signed by a second person. So the gap is worth
// catching on the DAY, and until now nothing did: the only attendance
// notification the platform sent went to GUARDIANS, about a child already marked
// absent. The teacher who had not marked anybody heard nothing at all.
//
// This sweep tells each class teacher, once, that their register is outstanding.
//
// WHY HOURLY FOR A DAILY REMINDER. A fleet spans timezones, so there is no one
// moment that is mid-afternoon everywhere: the same UTC instant is 14:00 in
// Lagos, 09:00 in Toronto and 22:00 in Singapore. The sweep runs every hour and
// acts on a school ONLY when that school's LOCAL clock reads
// REGISTER_REMINDER_LOCAL_HOUR — so each school is reminded once, in its own
// afternoon, and exactly one of the twenty-four ticks does the work. The same
// reasoning the overdue-boarder sweep already records.
//
// WHAT IT DOES NOT DO. It does not mark, chase, escalate, or record anything
// against a teacher. It is a reminder, and a reminder that repeats every hour
// until somebody acts trains people to dismiss it.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { NotificationService } from "../notifications/notification.service";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import { resolveRegion, schoolTimeString } from "@sms/types";

/**
 * The school's own local hour at which a missing register is worth a nudge.
 *
 * Mid-afternoon: late enough that a morning register really is overdue, early
 * enough that the teacher is still on site and can fix it today rather than
 * needing an amendment.
 */
export const REGISTER_REMINDER_LOCAL_HOUR = 14;

export interface RegisterReminderResult {
  /** Schools whose local clock matched the reminder hour on this tick. */
  schools: number;
  /** Registers outstanding across those schools. */
  outstanding: number;
  /**
   * TEACHERS TOLD — not registers iterated. A teacher with three untaken
   * classes is one person notified, and counting the classes would report three
   * people reminded when one was. The rule this repo records as "a counter must
   * count what was delivered".
   */
  notified: number;
  /**
   * Outstanding registers belonging to a class with no ACTIVE class teacher.
   * Nobody can be reminded about these, and they are the ones most likely to go
   * on being missed — so they are named rather than folded into `skipped`.
   */
  unreachable: number;
  /** Schools this run could not process. Not `skipped`: this is work it failed. */
  failed: number;
  /** Schools it looked at and correctly did nothing for (weekend, out of term). */
  skipped: number;
}

@Injectable()
export class RegisterReminderService {
  private readonly logger = new Logger(RegisterReminderService.name);

  constructor(
    @Inject(PrivilegedDatabaseService) private readonly db: PrivilegedDatabaseService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * One tick. Cross-tenant and privileged, like the dunning, staff-document and
   * overdue-boarder sweeps.
   *
   * `onlySchoolId` scopes it to a single school for the manual trigger — a
   * registrar pressing "run now" must not reach across the fleet, the defect
   * `a-fleet-sweep-one-school-could-fire` exists for.
   */
  async run(opts: { onlySchoolId?: string; force?: boolean } = {}): Promise<RegisterReminderResult> {
    const client = this.db.client;
    const out: RegisterReminderResult = {
      schools: 0,
      outstanding: 0,
      notified: 0,
      unreachable: 0,
      failed: 0,
      skipped: 0,
    };
    if (!client) {
      this.logger.warn("Register reminder: no privileged database URL — sweep disabled.");
      return out;
    }

    const schools = (await client.school.findMany({
      where: {
        status: "ACTIVE",
        isPlatform: false,
        ...(opts.onlySchoolId ? { id: opts.onlySchoolId } : {}),
      },
      select: { id: true, name: true, country: true, timezone: true },
    })) as Array<{ id: string; name: string; country: string | null; timezone: string | null }>;

    for (const school of schools) {
      try {
        const tz = resolveRegion(school).timezone;
        // The SCHOOL's clock, not the server's. `schoolTimeString` gives the
        // local wall time; the hour is what decides whether this is the tick.
        const local = schoolTimeString(tz, new Date()); // "YYYY-MM-DD HH:mm"
        const localDate = local.slice(0, 10);
        const localHour = Number(local.slice(11, 13));
        if (!opts.force && localHour !== REGISTER_REMINDER_LOCAL_HOUR) continue;

        out.schools += 1;

        // NOT ON A DAY THE SCHOOL IS NOT OPEN. A reminder on a Saturday is
        // noise, and noise is how a reminder stops being read.
        const dow = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
        if (dow === 0 || dow === 6) {
          out.skipped += 1;
          continue;
        }

        // Only inside the current term. Outside it there is no register to take,
        // and a school between terms would otherwise be nagged every weekday.
        const term = (await client.term.findFirst({
          where: { schoolId: school.id, isCurrent: true },
          select: { startDate: true, endDate: true },
        })) as { startDate: Date | null; endDate: Date | null } | null;
        if (!this.withinTerm(term, localDate)) {
          out.skipped += 1;
          continue;
        }

        const missing = await this.outstandingFor(client, school.id, localDate);
        out.outstanding += missing.length;
        if (missing.length === 0) continue;

        // ONE NOTIFICATION PER TEACHER, listing their classes — not one per
        // class. Three separate messages about three registers is the shape
        // people mute.
        const byTeacher = new Map<string, string[]>();
        for (const m of missing) {
          if (!m.teacherId) {
            out.unreachable += 1;
            continue;
          }
          byTeacher.set(m.teacherId, [...(byTeacher.get(m.teacherId) ?? []), m.className]);
        }
        if (byTeacher.size === 0) continue;

        // ONLY SOMEBODY STILL HERE. Addressing a leaver is addressing nobody,
        // and it would report them as reminded.
        const active = (await client.user.findMany({
          where: { id: { in: [...byTeacher.keys()] }, status: "ACTIVE" },
          select: { id: true },
        })) as Array<{ id: string }>;
        const activeIds = new Set(active.map((a) => a.id));
        for (const [teacherId, classes] of byTeacher) {
          if (!activeIds.has(teacherId)) {
            out.unreachable += classes.length;
            byTeacher.delete(teacherId);
          }
        }

        for (const [teacherId, classes] of byTeacher) {
          const names = classes.sort().join(", ");
          await this.notifications.enqueue(
            { schoolId: school.id, userId: SYSTEM_ACTOR_ID },
            {
              recipientId: teacherId,
              type: "ATTENDANCE_REGISTER_DUE",
              title: classes.length === 1 ? "Register not taken" : `${classes.length} registers not taken`,
              // Says WHICH classes and WHY it matters now, because "please take
              // your register" is a message people learn to skim.
              body:
                `No attendance has been recorded today for ${names}. ` +
                `An absence nobody records looks the same as a pupil who was present, ` +
                `and after seven days a correction needs a second member of staff to approve it.`,
              data: { date: localDate, classes },
            },
          );
          out.notified += 1;
        }
      } catch (err) {
        // PER SCHOOL, and COUNTED. One school's failure must not end the
        // fleet's sweep, and a count nobody surfaces is a count nobody acts on.
        out.failed += 1;
        this.logger.error(`Register reminder failed for ${school.name} (${school.id}): ${String(err)}`);
      }
    }

    const line =
      `Register reminder: schools=${out.schools} outstanding=${out.outstanding} ` +
      `notified=${out.notified} unreachable=${out.unreachable} failed=${out.failed} skipped=${out.skipped}`;
    if (out.failed > 0 || out.unreachable > 0) this.logger.warn(line);
    else this.logger.log(line);
    return out;
  }

  /** Is this local day inside the current term? Fail OPEN when a term carries no
   *  dates — a school mid-setup should still be reminded, and the alternative is
   *  silence nobody would notice. */
  private withinTerm(term: { startDate: Date | null; endDate: Date | null } | null, localDate: string): boolean {
    if (!term) return false;
    const day = `${localDate}T00:00:00.000Z`;
    if (term.startDate && new Date(day) < new Date(term.startDate)) return false;
    if (term.endDate && new Date(day) > new Date(term.endDate)) return false;
    return true;
  }

  /**
   * Classes with pupils on roll and NO register for the day.
   *
   * Batched: one query for the classes, one for the day's sessions, one for the
   * enrolment counts — never one per class. A class with nobody enrolled is not
   * an outstanding register; it is an empty class.
   */
  private async outstandingFor(
    client: NonNullable<PrivilegedDatabaseService["client"]>,
    schoolId: string,
    localDate: string,
  ): Promise<Array<{ classId: string; className: string; teacherId: string | null }>> {
    const date = new Date(`${localDate}T00:00:00.000Z`);
    const classes = (await client.class.findMany({
      where: { schoolId },
      select: { id: true, name: true, supervisorId: true },
    })) as Array<{ id: string; name: string; supervisorId: string | null }>;
    if (classes.length === 0) return [];
    const ids = classes.map((c) => c.id);

    const [sessions, enrolled] = await Promise.all([
      client.attendanceSession.findMany({ where: { schoolId, classId: { in: ids }, date }, select: { classId: true } }) as Promise<
        Array<{ classId: string }>
      >,
      client.enrollment.groupBy({
        by: ["classId"],
        where: { schoolId, classId: { in: ids }, status: "ACTIVE" },
        _count: { _all: true },
      } as never) as unknown as Promise<Array<{ classId: string; _count: { _all: number } }>>,
    ]);
    const taken = new Set(sessions.map((s) => s.classId));
    const roll = new Map(enrolled.map((e) => [e.classId, e._count._all]));

    return classes
      .filter((c) => !taken.has(c.id) && (roll.get(c.id) ?? 0) > 0)
      .map((c) => ({ classId: c.id, className: c.name, teacherId: c.supervisorId }));
  }
}
