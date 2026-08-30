// =============================================================================
// What a departing member of staff leaves behind
// =============================================================================
// Approving a staff exit closes the employment record, recovers loans, and ends
// the account's access on the last working day. It says nothing about the WORK.
//
// Nothing reassigns it and, worse, nothing NAMES it. The offboarding checklist
// has a task called "Handover notes", which is a tickbox — the same shape as
// "Revoke system access", which for a long time also did nothing.
//
// On the live database a single teacher holds THIRTY class-subject assignments.
// When they leave, thirty pairings point at somebody who cannot sign in, the
// timetable still shows their name, and the only symptom is a lesson nobody
// turns up to.
//
// Some of what they hold is worse than untidy, because it is DATED: a cover
// lesson next Tuesday, an exam they are rostered to invigilate, a meeting slot
// a parent can still book. Somebody has to be standing in a room. Those are
// flagged and listed first.
//
// THIS DOES NOT REASSIGN ANYTHING. The platform cannot know who should take a
// class, and quietly moving thirty assignments to a name the system picked is a
// far worse failure than the one it fixes. It produces the list a human works
// through — the same posture as integrity signals: evidence for a decision,
// never the decision.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import { schoolTimeString, schoolToday, type OpenDutyDto, type StaffHandoverDto } from "@sms/types";
import { SchoolRegionService } from "../foundation/school-region.service";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

/** How many examples to carry per duty. Enough to start a conversation. */
const DETAIL_SAMPLE = 5;

@Injectable()
export class StaffHandoverService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    private readonly region: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async openDuties(p: Principal, userId: string): Promise<StaffHandoverDto> {
    const tz = (await this.region.forSchool(p.schoolId)).timezone;
    return this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.dutiesIn(tx, userId, tz));
  }

  /**
   * The same question inside somebody else's transaction — used by the exit
   * approval, which must report this as part of the decision it is already
   * making rather than in a second request that might not happen.
   */
  async dutiesIn(tx: TenantTx, userId: string, timezone: string): Promise<StaffHandoverDto> {
    // FROM THE SCHOOL'S TODAY, not the server's. A cover lesson "tomorrow" is
    // tomorrow where the school is; deciding in UTC drops a Singapore morning's
    // duties and invents a Toronto evening's.
    const today = schoolToday(timezone);
    const user = (await tx.user.findFirst({ where: { id: userId }, select: { name: true } })) as { name: string } | null;

    const [classes, subjects, lessons, covers, invigilations, tasks, cases, slots, hostels, vehicles, appraisals, banks] =
      await Promise.all([
        // The classes they RUN — the register and the class itself, which is
        // the duty a handover most needs to name. Read off `class.supervisorId`,
        // the one place that records it now.
        tx.class
          .findMany({ where: { supervisorId: userId }, select: { id: true } })
          .then((rows: Array<{ id: string }>) => rows.map((c) => ({ classId: c.id }))),
        tx.classSubjectTeacher.findMany({ where: { teacherId: userId }, select: { classId: true, subjectId: true } }),
        tx.timetableEntry.findMany({ where: { teacherId: userId }, select: { subject: true, dayOfWeek: true } }),
        // DATED, and only what is still ahead: a cover lesson last month is
        // history, and listing it buries the one next Tuesday.
        tx.lessonCover.findMany({ where: { coveringTeacherId: userId, date: { gte: today } }, select: { date: true } }),
        tx.examInvigilator.findMany({
          where: { staffId: userId, sitting: { is: { date: { gte: today } } } },
          select: { sitting: { select: { title: true, date: true, hall: true } } },
        }),
        tx.taskAssignment.findMany({
          where: { assigneeId: userId, status: { not: "DONE" } },
          select: { task: { select: { title: true } } },
        }),
        tx.disciplineAssignee.findMany({
          where: { assigneeId: userId, complaint: { is: { status: { not: "CLOSED" } } } },
          select: { complaint: { select: { subject: true } } },
        }),
        tx.meetingSlot.findMany({ where: { teacherId: userId, startsAt: { gte: today } }, select: { startsAt: true } }),
        tx.hostel.findMany({ where: { wardenId: userId }, select: { name: true } }),
        tx.vehicle.findMany({ where: { driverId: userId }, select: { name: true } }),
        tx.appraisal.findMany({
          where: { reviewerId: userId, status: { not: "ACKNOWLEDGED" } },
          select: { id: true },
        }),
        // QUESTION BANKS THEY AUTHORED.
        //
        // Not a duty — nobody has to turn up for a question bank — but the one
        // thing on this list that is an ASSET rather than an obligation, and it
        // belongs here for the same reason the rest do: the school should know
        // what it has before the person who made it stops answering email.
        //
        // ACCESS IS NOT AT RISK and this notice does not imply it is: bank
        // visibility is decided by the READER's role, so a principal or school
        // admin sees every bank in the school whoever wrote it, and the next
        // teacher of that subject inherits it automatically. What is at risk is
        // that nobody KNOWS it exists — an exam bank for a subject whose author
        // has gone is only findable by somebody who thinks to look.
        tx.cbtQuestionBank.findMany({ where: { createdById: userId }, select: { name: true } }),
      ]);

    const classNames = await this.names(tx, [
      ...classes.map((c: { classId: string }) => c.classId),
      ...subjects.map((s: { classId: string }) => s.classId),
    ]);
    // A `@db.Date` is a DAY, and its UTC midnight IS that day — converting it
    // into a zone west of UTC would move it to the previous one. Cover lessons
    // and exam sittings are both day-typed, so this is right as it stands.
    const day = (d: Date) => d.toISOString().slice(0, 10);

    const duties: OpenDutyDto[] = [
      duty("COVER", "Cover lessons still to teach", covers.map((c: { date: Date }) => day(c.date)), true),
      duty(
        "INVIGILATION",
        "Exams they are rostered to invigilate",
        invigilations.map((i: { sitting: { title: string; date: Date; hall: string } }) =>
          `${i.sitting.title} — ${day(i.sitting.date)} (${i.sitting.hall})`),
        true,
      ),
      duty(
        "MEETING_SLOT",
        "Meeting slots a parent can still book",
        // A MEETING SLOT IS A TRUE TIMESTAMP, not a day column — the one entry
        // in this list that is. It printed the server's UTC while the two dated
        // duties above it were already resolved against `timezone`, three lines
        // from where that zone is in scope. The person reading this is arranging
        // cover for a slot a parent can still book, so the hour is the point.
        slots.map((s: { startsAt: Date }) => schoolTimeString(timezone, s.startsAt)),
        true,
      ),
      duty("CLASS_TEACHER", "Classes they are the class teacher of",
        classes.map((c: { classId: string }) => classNames.get(c.classId) ?? c.classId), false),
      duty("SUBJECT_TEACHER", "Class subjects they teach",
        subjects.map((s: { classId: string }) => classNames.get(s.classId) ?? s.classId), false),
      duty("TIMETABLED_LESSON", "Timetabled lessons in their name",
        lessons.map((l: { subject: string; dayOfWeek: string }) => `${l.subject} (${l.dayOfWeek})`), false),
      duty("TASK", "Tasks assigned to them and not done",
        tasks.map((t: { task: { title: string } }) => t.task.title), false),
      duty("DISCIPLINE_CASE", "Open discipline cases on their desk",
        (cases as Array<{ complaint: { subject: string } }>).map((c) => c.complaint.subject), false),
      duty("HOSTEL", "Hostels they are warden of", hostels.map((h: { name: string }) => h.name), false),
      duty("VEHICLE", "Vehicles they drive", vehicles.map((v: { name: string }) => v.name), false),
      duty(
        "QUESTION_BANK",
        "CBT question banks they wrote (still readable by leadership)",
        banks.map((b: { name: string }) => b.name),
        false,
      ),
      duty("APPRAISAL_REVIEWER", "Appraisals they have not finished as reviewer",
        appraisals.map(() => "in progress"), false),
    ].filter((d) => d.count > 0);

    // Dated duties first — somebody has to be in a room for those.
    duties.sort((a, b) => Number(b.dated) - Number(a.dated) || b.count - a.count);
    return {
      userId,
      userName: user?.name ?? null,
      duties,
      total: duties.reduce((n, d) => n + d.count, 0),
    };
  }

  private async names(tx: TenantTx, classIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(classIds)];
    if (ids.length === 0) return new Map();
    const rows = (await tx.class.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as Array<{
      id: string;
      name: string;
    }>;
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}

function duty(kind: OpenDutyDto["kind"], label: string, all: string[], dated: boolean): OpenDutyDto {
  return { kind, label, count: all.length, detail: all.slice(0, DETAIL_SAMPLE), dated };
}
