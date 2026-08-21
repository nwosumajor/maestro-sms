// =============================================================================
// ExamService — physical exam logistics: sittings, seating, invigilation
// =============================================================================
// Staff (exam.manage) schedule a sitting in a hall, auto-seat students, and
// roster invigilators. Students/parents see the student's own seat + hall +
// time; staff see the sittings they invigilate. Seating is idempotent-ish:
// re-seating replaces the plan. Notifications go to invigilators on assignment.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  ClashCandidate,
  ExamAttendanceDto,
  ExamAttendanceRowDto,
  ExamDayDto,
  ExamDayHallDto,
  ExamScheduleDto,
  ExamSittingDto,
  ExamSeatDto,
  MyExamDto,
  InvigilationDto,
} from "@sms/types";
import {
  EXAM_SCHEDULE_CHAIN,
  describeClash,
  findHallClash,
  findPersonClash,
  isValidTimeRange,
  schoolDateString,} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { NotificationService } from "../notifications/notification.service";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";
import { SchoolRegionService } from "../foundation/school-region.service";
import { assertStillHere } from "../common/still-here";

/** How many upcoming exams a personal list will return. A student sits a dozen a
 *  term; a parent of several children a few dozen. Well clear of real use, but it
 *  stops the query being unbounded. */
const MY_EXAMS_MAX = 200;
/** How far ahead "upcoming" reaches — one term's worth of published schedule. */
const MY_EXAMS_HORIZON_DAYS = 120;
const MY_EXAMS_HORIZON = (): Date => new Date(Date.now() + MY_EXAMS_HORIZON_DAYS * 24 * 60 * 60 * 1000);

@Injectable()
export class ExamService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
    private readonly workflow: WorkflowService,
    private readonly region: SchoolRegionService,
    hooks: WorkflowHooksService,
  ) {
    // Maker-checker reactor: when the exam-schedule approval finalizes, publish
    // every linked CBT exam (APPROVED) or return them to draft (REJECTED). Runs
    // in the workflow transition's tenant tx; idempotent via status-guarded
    // updateMany, so a replay or a board veto re-firing is a no-op.
    hooks.onFinalized(async (tx, req) => {
      if (req.type !== "EXAM_SCHEDULE_APPROVAL") return;
      const scheduleId = (req.payload as { scheduleId?: string } | null)?.scheduleId;
      if (!scheduleId) return;
      const approved = req.state === "APPROVED";
      const moved = await tx.examSchedule.updateMany({
        where: { id: scheduleId, status: "PENDING_REVIEW" },
        data: { status: approved ? "APPROVED" : "DRAFT" },
      });
      if (moved.count === 0) return; // already handled / not claimed
      const sittings = (await tx.examSitting.findMany({ where: { scheduleId }, select: { cbtExamId: true } })) as Array<{ cbtExamId: string | null }>;
      const examIds = [...new Set(sittings.map((s) => s.cbtExamId).filter((x): x is string => !!x))];
      if (examIds.length > 0) {
        await tx.cbtExam.updateMany({
          where: { id: { in: examIds }, status: "PENDING_APPROVAL" },
          data: { status: approved ? "PUBLISHED" : "DRAFT" },
        });
      }
      // AUTO-SEAT on approval: fill each CBT-backed sitting's plan from its exam's
      // class roster (skips any already-seated) — so approval turns empty seat
      // plans into populated ones instead of an admin seating every subject.
      let autoSeated = 0;
      // The shortfall matters just as much here: approval seats the schedule
      // unattended, so if a hall is too small for its class nobody is watching a
      // screen to notice. It goes on the audit row.
      let autoUnseated = 0;
      if (approved) {
        const outcome = await this.autoSeatSchedule(tx, req.schoolId, scheduleId);
        autoSeated = outcome.seatedCount;
        autoUnseated = outcome.overflow.reduce((n, o) => n + o.unseated, 0);
      }
      await this.audit.record(
        {
          actorId: req.initiatorId,
          action: approved ? "exam.schedule.approved" : "exam.schedule.rejected",
          entity: "exam_schedule",
          entityId: scheduleId,
          schoolId: req.schoolId,
          metadata: { requestId: req.id, exams: examIds.length, autoSeated, autoUnseated },
        },
        tx,
      );
    });
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private dateOnly(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  // --- clash detection --------------------------------------------------------

  /**
   * Refuse a sitting that double-books a hall. Reads only that DAY's sittings
   * (served by exam_sitting(schoolId, date)), so the cost is a handful of rows
   * regardless of how many terms of exam history the school has.
   *
   * `excludeId` is what makes EDITING possible: when re-timing a sitting it must
   * not be compared against itself, or every save would report a clash with the
   * row being saved.
   */
  private async assertNoHallClash(
    tx: TenantTx,
    input: { date: string; startsAt: string; endsAt: string; hall: string },
    excludeId?: string,
  ): Promise<void> {
    if (!isValidTimeRange(input.startsAt, input.endsAt)) {
      throw new BadRequestException("The end time must be after the start time (24h HH:MM)");
    }
    const sameDay = (await tx.examSitting.findMany({
      where: { date: new Date(`${input.date}T00:00:00.000Z`), ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, date: true, startsAt: true, endsAt: true, hall: true, title: true },
    })) as Array<{ id: string; date: Date; startsAt: string; endsAt: string; hall: string; title: string }>;
    const clash = findHallClash(input, sameDay.map((s) => ({ ...s, date: this.dateOnly(s.date) })));
    if (clash) throw new ConflictException(describeClash("hall", clash));
  }

  /**
   * Refuse rostering someone onto two overlapping sittings. Deliberately ignores
   * the hall — an invigilator cannot be in two places at once even when the halls
   * differ, which is precisely the case a hall-only check misses.
   */
  private async assertNoInvigilatorClash(
    tx: TenantTx,
    staffId: string,
    target: { id: string; date: Date; startsAt: string; endsAt: string },
  ): Promise<void> {
    const duties = (await tx.examInvigilator.findMany({
      where: { staffId, sittingId: { not: target.id } },
      select: { sitting: { select: { id: true, date: true, startsAt: true, endsAt: true, hall: true, title: true } } },
    })) as Array<{ sitting: { id: string; date: Date; startsAt: string; endsAt: string; hall: string; title: string } }>;
    const others: ClashCandidate[] = duties
      .filter((d) => this.dateOnly(d.sitting.date) === this.dateOnly(target.date))
      .map((d) => ({ ...d.sitting, date: this.dateOnly(d.sitting.date) }));
    const clash = findPersonClash({ date: this.dateOnly(target.date), startsAt: target.startsAt, endsAt: target.endsAt }, others);
    if (clash) throw new ConflictException(describeClash("invigilator", clash));
  }

  /**
   * Resolve a picked room into the hall LABEL and a capacity default. The label is
   * stored alongside the id so a past sitting still reads honestly after the room
   * is renamed or removed; the capacity default is what stops it being retyped
   * (and mistyped) for every sitting in a hall.
   */
  private async resolveRoom(
    tx: TenantTx,
    roomId: string | null | undefined,
    fallbackHall: string | undefined,
    givenCapacity: number | undefined,
  ): Promise<{ roomId: string | null; hall: string; capacity: number }> {
    if (roomId) {
      const room = (await tx.room.findFirst({ where: { id: roomId }, select: { id: true, name: true, capacity: true } })) as
        | { id: string; name: string; capacity: number | null }
        | null;
      if (!room) throw new NotFoundException("Room not found");
      return { roomId: room.id, hall: room.name, capacity: givenCapacity ?? room.capacity ?? 0 };
    }
    const hall = (fallbackHall ?? "").trim();
    if (!hall) throw new BadRequestException("Pick a room or type a hall name");
    return { roomId: null, hall, capacity: givenCapacity ?? 0 };
  }

  /** In-tenant existence check for an optional class, returning its NAME so the
   *  caller can echo it back (404, never cross-tenant leak). The name matters:
   *  a response carrying `classId` but a null `className` renders as "no class"
   *  in the UI even though one was just set. */
  private async assertClass(tx: TenantTx, classId: string | null | undefined): Promise<string | null> {
    if (!classId) return null;
    const cls = (await tx.class.findFirst({ where: { id: classId }, select: { name: true } })) as { name: string } | null;
    if (!cls) throw new NotFoundException("Class not found");
    return cls.name;
  }

  // --- staff: sittings --------------------------------------------------------

  async createSitting(
    p: Principal,
    input: {
      title: string;
      subject?: string;
      date: string;
      startsAt: string;
      endsAt: string;
      hall?: string;
      roomId?: string | null;
      capacity?: number;
      note?: string;
      classId?: string | null;
      scheduleId?: string | null;
      cbtExamId?: string | null;
    },
  ): Promise<ExamSittingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Validate the schedule + CBT exam are in-tenant, and that a CBT-backed
      // sitting only attaches a DRAFT exam (it gets published via the schedule
      // approval, never already-live).
      let cbtStatus: string | null = null;
      if (input.scheduleId) {
        const sched = await tx.examSchedule.findFirst({ where: { id: input.scheduleId, status: "DRAFT" }, select: { id: true } });
        if (!sched) throw new BadRequestException("Schedule not found or already submitted for approval");
      }
      if (input.cbtExamId) {
        const exam = await tx.cbtExam.findFirst({ where: { id: input.cbtExamId }, select: { id: true, status: true } });
        if (!exam) throw new NotFoundException("CBT exam not found");
        if (exam.status !== "DRAFT") throw new ConflictException("Only a DRAFT CBT exam can be attached to a sitting");
        // One exam ↔ one sitting: refuse if it's already linked.
        const linked = await tx.examSitting.findFirst({ where: { cbtExamId: input.cbtExamId }, select: { id: true } });
        if (linked) throw new ConflictException("That CBT exam is already attached to a sitting");
        cbtStatus = exam.status;
      }
      const className = await this.assertClass(tx, input.classId);
      const venue = await this.resolveRoom(tx, input.roomId, input.hall, input.capacity);
      // Refuse a double-booked hall BEFORE writing, so a clash is never persisted
      // and then discovered on exam morning.
      await this.assertNoHallClash(tx, { date: input.date, startsAt: input.startsAt, endsAt: input.endsAt, hall: venue.hall });
      const row = (await tx.examSitting.create({
        data: {
          schoolId: p.schoolId,
          title: input.title,
          subject: input.subject ?? null,
          date: new Date(`${input.date}T00:00:00.000Z`),
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          hall: venue.hall,
          roomId: venue.roomId,
          capacity: venue.capacity,
          note: input.note ?? null,
          classId: input.classId ?? null,
          scheduleId: input.scheduleId ?? null,
          cbtExamId: input.cbtExamId ?? null,
          createdById: p.userId,
        },
      })) as SittingRow;
      await this.audit.record(
        { actorId: p.userId, action: "exam.sitting.create", entity: "exam_sitting", entityId: row.id, schoolId: p.schoolId },
        tx,
      );
      return this.toSittingDto(row, 0, 0, { status: cbtStatus, released: false, started: 0, submitted: 0 }, className);
    });
  }

  /**
   * Edit a sitting IN PLACE — the point being that it leaves the seating plan and
   * the invigilator roster alone.
   *
   * Before this existed the only way to correct a sitting was delete + recreate,
   * and deleteSitting cascades seats and invigilators. So moving an exam thirty
   * minutes, or fixing a typo'd hall, silently destroyed a seating plan for a
   * whole class and a roster that had already been notified to staff. That is the
   * kind of data loss nobody attributes to the tool: it just looks like the seats
   * "never saved".
   *
   * A RELEASED sitting is frozen (409). Students may be mid-exam against a server
   * clock derived from the exam, so re-timing it underneath them is never a
   * correction — it is an incident. Everything short of that stays editable,
   * because halls really do change on the morning, and every change is audited
   * with its before/after so the record shows who moved what.
   */
  async updateSitting(
    p: Principal,
    id: string,
    patch: {
      title?: string;
      subject?: string | null;
      date?: string;
      startsAt?: string;
      endsAt?: string;
      hall?: string;
      roomId?: string | null;
      capacity?: number;
      note?: string | null;
      classId?: string | null;
    },
  ): Promise<ExamSittingDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const current = (await tx.examSitting.findFirst({ where: { id } })) as SittingRow | null;
      if (!current) throw new NotFoundException("Sitting not found");

      if (current.cbtExamId) {
        const exam = (await tx.cbtExam.findFirst({ where: { id: current.cbtExamId }, select: { releasedAt: true } })) as
          | { releasedAt: Date | null }
          | null;
        if (exam?.releasedAt) {
          throw new ConflictException("This exam has been released and students may be sitting it — it can no longer be edited");
        }
      }

      // Merge patch over current so a partial edit still clash-checks against the
      // FULL resulting sitting, not just the fields that happened to change.
      const date = patch.date ?? this.dateOnly(current.date);
      const startsAt = patch.startsAt ?? current.startsAt;
      const endsAt = patch.endsAt ?? current.endsAt;
      const roomTouched = patch.roomId !== undefined || patch.hall !== undefined || patch.capacity !== undefined;
      const venue = roomTouched
        ? await this.resolveRoom(
            tx,
            patch.roomId !== undefined ? patch.roomId : current.roomId,
            patch.hall ?? current.hall,
            patch.capacity,
          )
        : { roomId: current.roomId, hall: current.hall, capacity: current.capacity };
      if (patch.classId !== undefined) await this.assertClass(tx, patch.classId);

      await this.assertNoHallClash(tx, { date, startsAt, endsAt, hall: venue.hall }, id);

      const data = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.date !== undefined ? { date: new Date(`${date}T00:00:00.000Z`) } : {}),
        ...(patch.startsAt !== undefined ? { startsAt } : {}),
        ...(patch.endsAt !== undefined ? { endsAt } : {}),
        ...(roomTouched ? { hall: venue.hall, roomId: venue.roomId, capacity: venue.capacity } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.classId !== undefined ? { classId: patch.classId } : {}),
      };
      if (Object.keys(data).length === 0) throw new BadRequestException("Nothing to change");

      const row = (await tx.examSitting.update({ where: { id }, data })) as SittingRow;

      // Audit the CHANGED fields with before/after. A bare "updated" entry would
      // not answer the only question ever asked afterwards: what did it used to be?
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of Object.keys(data) as Array<keyof typeof data>) {
        const before = (current as unknown as Record<string, unknown>)[k];
        const after = (row as unknown as Record<string, unknown>)[k];
        const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
        if (norm(before) !== norm(after)) changed[k as string] = { from: norm(before), to: norm(after) };
      }
      await this.audit.record(
        {
          actorId: p.userId,
          action: "exam.sitting.update",
          entity: "exam_sitting",
          entityId: id,
          schoolId: p.schoolId,
          metadata: { changed },
        },
        tx,
      );

      // Re-read the counts so the caller gets a truthful row back — and so the UI
      // can SEE that seats and invigilators survived the edit.
      const [seated, invigilators, cls] = await Promise.all([
        tx.examSeat.count({ where: { sittingId: id } }) as Promise<number>,
        tx.examInvigilator.count({ where: { sittingId: id } }) as Promise<number>,
        row.classId
          ? (tx.class.findFirst({ where: { id: row.classId }, select: { name: true } }) as Promise<{ name: string } | null>)
          : Promise.resolve(null),
      ]);
      const exam = row.cbtExamId
        ? ((await tx.cbtExam.findFirst({ where: { id: row.cbtExamId }, select: { status: true, releasedAt: true } })) as
            | { status: string; releasedAt: Date | null }
            | null)
        : null;
      return this.toSittingDto(
        row,
        seated,
        invigilators,
        { status: exam?.status ?? null, released: !!exam?.releasedAt, started: 0, submitted: 0 },
        cls?.name ?? null,
      );
    });
  }

  /**
   * Sittings, FILTERED server-side.
   *
   * The unfiltered list was capped at 200 and rendered whole. A term is subjects ×
   * class levels, so a real school blows past a hundred sittings and an exam
   * officer was left scrolling one flat list to find Tuesday's halls. Every filter
   * here narrows the QUERY, so choosing a schedule or a single day makes the
   * payload smaller rather than shipping everything and hiding rows in the browser.
   */
  async listSittings(
    p: Principal,
    filter: { scheduleId?: string; from?: string; to?: string; date?: string; hall?: string; q?: string } = {},
  ): Promise<ExamSittingDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = {};
      if (filter.scheduleId) where.scheduleId = filter.scheduleId;
      if (filter.date) {
        where.date = new Date(`${filter.date}T00:00:00.000Z`);
      } else if (filter.from || filter.to) {
        where.date = {
          ...(filter.from ? { gte: new Date(`${filter.from}T00:00:00.000Z`) } : {}),
          ...(filter.to ? { lte: new Date(`${filter.to}T00:00:00.000Z`) } : {}),
        };
      }
      if (filter.hall) where.hall = { equals: filter.hall, mode: "insensitive" };
      if (filter.q) {
        const q = filter.q.trim();
        if (q) where.OR = [{ title: { contains: q, mode: "insensitive" } }, { subject: { contains: q, mode: "insensitive" } }];
      }
      const rows = (await tx.examSitting.findMany({ where, orderBy: [{ date: "desc" }, { startsAt: "asc" }], take: 200 })) as SittingRow[];
      const ids = rows.map((r) => r.id);
      const examIds = [...new Set(rows.map((r) => r.cbtExamId).filter((x): x is string => !!x))];
      // Seat/invigilator counts + the CBT exams' status/release in a fixed number
      // of batched queries (never per row).
      const [seats, invs, exams] = await Promise.all([
        this.countBy(tx, "examSeat", "sittingId", ids),
        this.countBy(tx, "examInvigilator", "sittingId", ids),
        examIds.length
          ? (tx.cbtExam.findMany({ where: { id: { in: examIds } }, select: { id: true, status: true, releasedAt: true } }) as Promise<Array<{ id: string; status: string; releasedAt: Date | null }>>)
          : Promise.resolve([] as Array<{ id: string; status: string; releasedAt: Date | null }>),
      ]);
      const examById = new Map(exams.map((e) => [e.id, e]));
      // The started/submitted tallies are only DISPLAYED for a RELEASED exam, so
      // the sitting groupBy is scoped to just those (a handful on exam day) — it
      // never aggregates the sittings of years of long-closed exams on each load.
      const releasedExamIds = exams.filter((e) => e.releasedAt).map((e) => e.id);
      const tallies = releasedExamIds.length
        ? ((await tx.cbtSitting.groupBy({ by: ["examId", "status"], where: { examId: { in: releasedExamIds } }, _count: { _all: true } } as never)) as unknown as Array<{ examId: string; status: string; _count: { _all: number } }>)
        : [];
      const started = new Map<string, number>();
      const submitted = new Map<string, number>();
      for (const t of tallies) {
        started.set(t.examId, (started.get(t.examId) ?? 0) + t._count._all);
        if (t.status === "SUBMITTED" || t.status === "EXPIRED") submitted.set(t.examId, (submitted.get(t.examId) ?? 0) + t._count._all);
      }
      // Class names in ONE query keyed by the distinct classIds on the page — the
      // list shows "Mathematics · SS1", and an id would make the grid unreadable.
      const classIds = [...new Set(rows.map((r) => r.classId).filter((x): x is string => !!x))];
      const classes = classIds.length
        ? ((await tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } })) as Array<{ id: string; name: string }>)
        : [];
      const classById = new Map(classes.map((c) => [c.id, c.name]));
      return rows.map((r) => {
        const e = r.cbtExamId ? examById.get(r.cbtExamId) : undefined;
        return this.toSittingDto(
          r,
          seats.get(r.id) ?? 0,
          invs.get(r.id) ?? 0,
          {
            status: e?.status ?? null,
            released: !!e?.releasedAt,
            started: r.cbtExamId ? started.get(r.cbtExamId) ?? 0 : 0,
            submitted: r.cbtExamId ? submitted.get(r.cbtExamId) ?? 0 : 0,
          },
          r.classId ? classById.get(r.classId) ?? null : null,
        );
      });
    });
  }

  /**
   * The exam-day board: one date, grouped by hall, with the warnings computed
   * server-side.
   *
   * This exists because the questions asked while walking the halls on exam
   * morning are not the questions the planning list answers. "Is Hall B started?"
   * and above all "is anyone actually invigilating Hall B?" — an unstaffed hall is
   * the one omission that cannot be repaired after the fact, so it is surfaced as
   * a flag on the payload rather than something the browser has to notice.
   */
  /** `date` omitted means TODAY AT THE SCHOOL — never the server's UTC day.
   *  The controller used to default it, and a school east of UTC opening this
   *  board on an exam morning (07:00 in Singapore is 23:00 the previous day in
   *  UTC) was shown YESTERDAY's exam day: the wrong halls, the wrong sittings,
   *  on the morning it matters most. */
  async examDay(p: Principal, date?: string): Promise<ExamDayDto> {
    const day = date ?? schoolDateString((await this.region.forSchool(p.schoolId)).timezone);
    return this.examDayFor(p, day);
  }

  private async examDayFor(p: Principal, date: string): Promise<ExamDayDto> {
    const sittings = await this.listSittings(p, { date });
    // Register tallies for the whole day in one read, so a hall shows how many
    // failed to turn up next to how many were expected.
    const tallies = await this.db.runAsTenantReadOnly(this.ctx(p), (tx) =>
      this.attendanceTallies(tx, sittings.map((s) => s.id)),
    );
    const halls: ExamDayHallDto[] = sittings
      .map((s) => {
        const overCapacity = s.capacity > 0 && s.seated > s.capacity;
        // Reuse the SAME pure clash rule the writes enforce, so a sitting that
        // predates the check (or was created before this release) still shows up.
        const clash = findHallClash(
          { date: s.date, startsAt: s.startsAt, endsAt: s.endsAt, hall: s.hall },
          sittings.filter((o) => o.id !== s.id).map((o) => ({ id: o.id, date: o.date, startsAt: o.startsAt, endsAt: o.endsAt, hall: o.hall, title: o.title })),
        );
        return {
          sittingId: s.id,
          hall: s.hall,
          title: s.title,
          subject: s.subject,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          seated: s.seated,
          capacity: s.capacity,
          invigilators: s.invigilators,
          cbtStatus: s.cbtStatus,
          released: s.released,
          started: s.started,
          submitted: s.submitted,
          noInvigilator: s.invigilators === 0,
          noSeats: s.seated === 0,
          absent: tallies.get(s.id)?.absent ?? 0,
          // Seated but unmarked. Reported as a COUNT rather than folded into
          // `absent`, because "we have not taken the register" and "they did not
          // come" are different problems with different fixes.
          unmarked: Math.max(0, s.seated - (tallies.get(s.id)?.marked ?? 0)),
          warning: clash
            ? describeClash("hall", clash)
            : overCapacity
              ? `${s.seated} seated in a hall of ${s.capacity}`
              : null,
        };
      })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.hall.localeCompare(b.hall));
    return { date, halls };
  }

  async deleteSitting(p: Principal, id: string): Promise<{ deleted: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const res = await tx.examSitting.deleteMany({ where: { id } }); // cascades seats + invigilators
      if (res.count === 0) throw new NotFoundException("Sitting not found");
      await this.audit.record(
        { actorId: p.userId, action: "exam.sitting.delete", entity: "exam_sitting", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return { deleted: true };
    });
  }

  // --- schedules (maker-checker) + day-of release -----------------------------

  async createSchedule(p: Principal, input: { title: string; termId?: string | null }): Promise<ExamScheduleDto> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.examSchedule.create({
        data: { schoolId: p.schoolId, title: input.title, termId: input.termId ?? null, createdById: p.userId },
      });
      await this.audit.record(
        { actorId: p.userId, action: "exam.schedule.create", entity: "exam_schedule", entityId: row.id, schoolId: p.schoolId },
        tx,
      );
      return { id: row.id, title: row.title, termId: row.termId, status: row.status, createdAt: row.createdAt.toISOString(), sittingCount: 0, cbtCount: 0 };
    });
  }

  async listSchedules(p: Principal): Promise<ExamScheduleDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = (await tx.examSchedule.findMany({ orderBy: { createdAt: "desc" }, take: 100 })) as Array<{ id: string; title: string; termId: string | null; status: string; createdAt: Date }>;
      if (rows.length === 0) return [];
      // TWO grouped COUNTs (total sittings, and CBT-backed sittings) — the DB
      // aggregates and returns ~one row per schedule, instead of shipping every
      // sitting row to be counted in Node. No per-schedule fan-out; constant work.
      const ids = rows.map((r) => r.id);
      const [totals, cbts] = await Promise.all([
        tx.examSitting.groupBy({ by: ["scheduleId"], where: { scheduleId: { in: ids } }, _count: { _all: true } } as never) as unknown as Promise<Array<{ scheduleId: string; _count: { _all: number } }>>,
        tx.examSitting.groupBy({ by: ["scheduleId"], where: { scheduleId: { in: ids }, cbtExamId: { not: null } }, _count: { _all: true } } as never) as unknown as Promise<Array<{ scheduleId: string; _count: { _all: number } }>>,
      ]);
      const total = new Map(totals.map((t) => [t.scheduleId, t._count._all]));
      const cbt = new Map(cbts.map((t) => [t.scheduleId, t._count._all]));
      return rows.map((r) => ({ id: r.id, title: r.title, termId: r.termId, status: r.status, createdAt: r.createdAt.toISOString(), sittingCount: total.get(r.id) ?? 0, cbtCount: cbt.get(r.id) ?? 0 }));
    });
  }

  /** Maker-checker: submit a whole schedule for head-teacher → principal approval.
   *  Claims the schedule (DRAFT → PENDING_REVIEW) and parks its CBT exams
   *  PENDING_APPROVAL; the finalized reactor publishes them on approval. */
  async requestScheduleApproval(p: Principal, scheduleId: string): Promise<{ pendingApproval: true; requestId: string }> {
    const claimed = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sched = await tx.examSchedule.findFirst({ where: { id: scheduleId }, select: { id: true, title: true } });
      if (!sched) throw new NotFoundException("Schedule not found");
      const sittings = (await tx.examSitting.findMany({ where: { scheduleId }, select: { cbtExamId: true } })) as Array<{ cbtExamId: string | null }>;
      if (sittings.length === 0) throw new ConflictException("Add at least one sitting before submitting the schedule");
      const res = await tx.examSchedule.updateMany({ where: { id: scheduleId, status: "DRAFT" }, data: { status: "PENDING_REVIEW" } });
      if (res.count === 0) throw new ConflictException("Only a draft schedule can be submitted for approval");
      const examIds = [...new Set(sittings.map((s) => s.cbtExamId).filter((x): x is string => !!x))];
      if (examIds.length > 0) {
        await tx.cbtExam.updateMany({ where: { id: { in: examIds }, status: "DRAFT" }, data: { status: "PENDING_APPROVAL" } });
      }
      await this.audit.record(
        { actorId: p.userId, action: "exam.schedule.submit", entity: "exam_schedule", entityId: scheduleId, schoolId: p.schoolId, metadata: { exams: examIds.length } },
        tx,
      );
      return { title: sched.title };
    });
    // Raise + submit the two-stage approval; release the claim if it fails so the
    // schedule can never strand in PENDING_REVIEW without a reviewer.
    try {
      const req = (await this.workflow.createRequest(p, {
        type: "EXAM_SCHEDULE_APPROVAL",
        title: `Approve exam schedule: ${claimed.title}`,
        payload: { scheduleId },
        stages: [...EXAM_SCHEDULE_CHAIN],
      })) as { id: string };
      await this.workflow.submit(p, req.id);
      return { pendingApproval: true, requestId: req.id };
    } catch (err) {
      await this.db.runAsTenant(this.ctx(p), async (tx) => {
        await tx.examSchedule.updateMany({ where: { id: scheduleId, status: "PENDING_REVIEW" }, data: { status: "DRAFT" } });
        const sittings = (await tx.examSitting.findMany({ where: { scheduleId }, select: { cbtExamId: true } })) as Array<{ cbtExamId: string | null }>;
        const examIds = [...new Set(sittings.map((s) => s.cbtExamId).filter((x): x is string => !!x))];
        if (examIds.length > 0) await tx.cbtExam.updateMany({ where: { id: { in: examIds }, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } });
      });
      throw err;
    }
  }

  /** Day-of RELEASE (open) an approved CBT-backed sitting for students to sit.
   *  A single authorized action (exam.release: principal / head teacher /
   *  school admin). The exam must be PUBLISHED (schedule approved) and its date
   *  today; releasing sets releasedAt, which startSitting requires. */
  async releaseSitting(
    p: Principal,
    sittingId: string,
  ): Promise<{ released: true; examId: string; alreadyReleased?: true }> {
    const { examId, title, recipients, alreadyReleased } = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = (await tx.examSitting.findFirst({ where: { id: sittingId }, select: { cbtExamId: true, date: true, title: true } })) as { cbtExamId: string | null; date: Date; title: string } | null;
      if (!sitting) throw new NotFoundException("Sitting not found");
      if (!sitting.cbtExamId) throw new BadRequestException("This is a paper sitting — nothing to release online");
      // Release is meant for the exam day: refuse before the scheduled date —
      // the SCHOOL's date. Judged in UTC, a school east of it could not release
      // its own morning paper: at 07:00 in Singapore the server still reads the
      // previous day, so the sitting looked like it was in the future and an
      // invigilator was refused at exactly the moment they needed it.
      const today = await this.region.todayInTx(tx, p.schoolId);
      if (new Date(sitting.date) > today) {
        // NAME THE DATE. An invigilator refused on exam morning could not tell
        // whether they were early or the sitting was mis-dated, and the CBT page
        // does not show the sitting at all — so there was nowhere to go and look.
        throw new ConflictException(
          `"${sitting.title}" is scheduled for ${new Date(sitting.date).toISOString().slice(0, 10)}, so it cannot be released yet.`,
        );
      }
      const res = await tx.cbtExam.updateMany({
        where: { id: sitting.cbtExamId, status: "PUBLISHED", releasedAt: null },
        data: { releasedAt: new Date(), releasedById: p.userId },
      });
      if (res.count === 0) {
        // "Not approved OR already released" is an OR of two opposite
        // situations: one means go and get it approved, the other means the
        // paper is already open and the hall can start. Told both at once, on
        // exam morning, an invigilator cannot tell whether to panic.
        const exam = await tx.cbtExam.findFirst({
          where: { id: sitting.cbtExamId },
          select: { status: true, releasedAt: true },
        });
        if (exam?.releasedAt) {
          // ALREADY RELEASED IS NOT A FAILURE. The desired state holds; pressing
          // the button twice — two invigilators, or one impatient click — must
          // not read as something broken. Idempotent, and says when it happened.
          return { examId: sitting.cbtExamId, title: sitting.title, recipients: [], alreadyReleased: true };
        }
        throw new ConflictException(
          exam
            ? `"${sitting.title}" is ${exam.status}, not PUBLISHED — its schedule needs approving before the paper can be released.`
            : "That paper no longer exists.",
        );
      }
      await this.audit.record(
        { actorId: p.userId, action: "exam.release", entity: "cbt", entityId: sitting.cbtExamId, schoolId: p.schoolId, metadata: { sittingId } },
        tx,
      );
      // Recipients = the seated students + their guardians (collected in-tx,
      // notified after commit so a notification hiccup never rolls back a release).
      const seatRows = (await tx.examSeat.findMany({ where: { sittingId }, select: { studentId: true } })) as Array<{ studentId: string }>;
      const studentIds = seatRows.map((s) => s.studentId);
      const guardians = studentIds.length
        ? ((await tx.parentChild.findMany({ where: { studentId: { in: studentIds } }, select: { parentId: true } })) as Array<{ parentId: string }>)
        : [];
      const recipients = [...new Set([...studentIds, ...guardians.map((g) => g.parentId)])];
      return { examId: sitting.cbtExamId, title: sitting.title, recipients, alreadyReleased: undefined as true | undefined };
    });
    // AUTO-NOTIFY every seated student + guardian, in ONE batch. This used to be a
    // sequential await per recipient — ~100 transactions and queue round-trips for a
    // single class, on the one click a principal makes with a hall full of students
    // waiting. Failures here are swallowed by design: the release has committed and
    // must be reported as done.
    try {
      await this.notifications.enqueueMany(this.ctx(p), recipients, {
        type: "GENERIC",
        title: `Exam open: ${title}`,
        body: `The ${title} exam is now open. Sign in and click to start — you have until the timer ends or you submit.`,
        channels: ["EMAIL"],
      });
    } catch {
      /* non-fatal: the exam is open either way */
    }
    // `alreadyReleased` lets the screen say "already open" instead of implying a
    // fresh release — the hall is running either way, which is what matters.
    return { released: true as const, examId, ...(alreadyReleased ? { alreadyReleased } : {}) };
  }

  // --- staff: seating ---------------------------------------------------------

  /** Replace the sitting's seating plan with the given students, seat 1..N.
   *  Respects the sitting capacity when set. */
  async seat(p: Principal, sittingId: string, studentIds: string[]): Promise<ExamSeatDto[]> {
    const uniq = [...new Set(studentIds)];
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = await tx.examSitting.findFirst({ where: { id: sittingId }, select: { id: true, capacity: true } });
      if (!sitting) throw new NotFoundException("Sitting not found");
      if (sitting.capacity > 0 && uniq.length > sitting.capacity) {
        throw new ConflictException(`Only ${sitting.capacity} seats in this hall (${uniq.length} students given)`);
      }
      await tx.examSeat.deleteMany({ where: { sittingId } });
      await tx.examSeat.createMany({
        data: uniq.map((studentId, i) => ({ schoolId: p.schoolId, sittingId, studentId, seatNo: i + 1 })),
      });
      await this.audit.record(
        { actorId: p.userId, action: "exam.seat.assign", entity: "exam_sitting", entityId: sittingId, schoolId: p.schoolId, metadata: { seats: uniq.length } },
        tx,
      );
      return this.seatPlan(tx, sittingId);
    });
  }

  /**
   * Fill the seat plan of every CBT-backed sitting in a schedule from its exam's
   * class roster (seat 1..N, capped at the hall capacity), skipping any sitting
   * that is already seated. Fully BATCHED (sittings, their exams' classes, the
   * already-seated set, and all enrolments in a fixed number of queries; then one
   * bulk createMany per sitting) — bounded by the schedule size, never per-student
   * fan-out. Returns how many sittings were seated. Runs inside the reactor tx.
   */
  private async autoSeatSchedule(
    tx: TenantTx,
    schoolId: string,
    scheduleId: string,
  ): Promise<{
    seatedCount: number;
    seatedStudents: number;
    overflow: Array<{ sittingId: string; capacity: number; classSize: number; unseated: number }>;
    reasons: { alreadySeated: number; noClass: number; emptyClass: number };
  }> {
    // EVERY sitting in the schedule, not just the CBT-backed ones. A sitting knows
    // its class either directly (sitting.classId — the only source a PAPER exam
    // has) or through its backing CBT exam. Before sitting.classId existed this
    // could only ever seat online exams, so an exam officer still hand-seated
    // every paper hall one dropdown at a time.
    const sittings = (await tx.examSitting.findMany({
      where: { scheduleId },
      select: { id: true, cbtExamId: true, classId: true, capacity: true },
    })) as Array<{ id: string; cbtExamId: string | null; classId: string | null; capacity: number }>;
    const empty = { seatedCount: 0, seatedStudents: 0, overflow: [], reasons: { alreadySeated: 0, noClass: 0, emptyClass: 0 } };
    if (sittings.length === 0) return empty;
    const examIds = [...new Set(sittings.map((s) => s.cbtExamId).filter((x): x is string => !!x))];
    const exams = examIds.length
      ? ((await tx.cbtExam.findMany({ where: { id: { in: examIds } }, select: { id: true, classId: true } })) as Array<{ id: string; classId: string | null }>)
      : [];
    const classByExam = new Map(exams.map((e) => [e.id, e.classId]));
    // The sitting's OWN class wins: it is the explicit instruction, and an exam
    // moved to a different cohort should not silently keep seating the exam's.
    const classOf = (s: { cbtExamId: string | null; classId: string | null }): string | null =>
      s.classId ?? (s.cbtExamId ? classByExam.get(s.cbtExamId) ?? null : null);
    // Which of these sittings already have a seat plan? Skipping them is what makes
    // this safe to re-run: a second pass never renumbers seats students were told.
    const already = (await tx.examSeat.groupBy({ by: ["sittingId"], where: { sittingId: { in: sittings.map((s) => s.id) } }, _count: { _all: true } } as never)) as unknown as Array<{ sittingId: string }>;
    const hasSeats = new Set(already.map((g) => g.sittingId));
    const classIds = [...new Set(sittings.map(classOf).filter((x): x is string => !!x))];
    if (classIds.length === 0) return { ...empty, reasons: { alreadySeated: 0, noClass: sittings.length, emptyClass: 0 } };
    const enr = (await tx.enrollment.findMany({ where: { status: "ACTIVE", classId: { in: classIds } }, select: { classId: true, studentId: true } })) as Array<{ classId: string; studentId: string }>;
    const byClass = new Map<string, string[]>();
    for (const e of enr) byClass.set(e.classId, [...(byClass.get(e.classId) ?? []), e.studentId]);
    let seatedCount = 0;
    let seatedStudents = 0;
    // WHO WAS LEFT WITHOUT A SEAT, and why a sitting was passed over. Counting
    // SITTINGS was the whole story before, and it hid the case that matters: a
    // hall smaller than its class is truncated silently below, the sitting still
    // counts as seated, and nobody learns that children have no seat until they
    // are standing in the corridor on exam morning.
    const overflow: Array<{ sittingId: string; capacity: number; classSize: number; unseated: number }> = [];
    const reasons = { alreadySeated: 0, noClass: 0, emptyClass: 0 };
    for (const s of sittings) {
      if (hasSeats.has(s.id)) {
        reasons.alreadySeated += 1;
        continue;
      }
      const classId = classOf(s);
      if (!classId) {
        // Nothing tells this sitting whose exam it is — it can never seat, and
        // an exam officer needs to know that now rather than on the day.
        reasons.noClass += 1;
        continue;
      }
      const roll = byClass.get(classId) ?? [];
      let studentIds = roll;
      if (s.capacity > 0 && roll.length > s.capacity) {
        studentIds = roll.slice(0, s.capacity);
        overflow.push({ sittingId: s.id, capacity: s.capacity, classSize: roll.length, unseated: roll.length - s.capacity });
      }
      if (studentIds.length === 0) {
        reasons.emptyClass += 1;
        continue;
      }
      await tx.examSeat.createMany({ data: studentIds.map((studentId, i) => ({ schoolId, sittingId: s.id, studentId, seatNo: i + 1 })) });
      seatedCount += 1;
      seatedStudents += studentIds.length;
    }
    return { seatedCount, seatedStudents, overflow, reasons };
  }

  /**
   * Seat every unseated sitting in a schedule, on demand.
   *
   * Approval already does this, but only once and only at that moment — a sitting
   * added afterwards, or one whose class was set later, stayed empty with no way
   * to fill it except the per-sitting dropdown. This is the same batched routine
   * exposed as a button, and because it skips already-seated sittings it is safe to
   * press repeatedly: it never renumbers a seat a student has already been told.
   */
  /**
   * Seat every unseated sitting in a schedule.
   *
   * REPORTS PUPILS, not just sittings. It used to answer `{ seated, skipped }`
   * counting SITTINGS, which hid the case that matters: a hall smaller than its
   * class is filled to capacity and the rest of the roll gets no seat, while the
   * sitting counts as seated and `skipped` stays 0. Verified live — a class of
   * 30 in a hall of 5 returned `{"seated":1,"skipped":0}` with five seats
   * created, and the screen said "Seated every unseated sitting in this
   * schedule." Twenty-five children would have found that out in the corridor on
   * exam morning.
   *
   * Partial seating is still done rather than refused — filling one hall and
   * opening another is ordinary practice — but the shortfall is now named, per
   * hall, along with why any sitting was passed over.
   */
  async seatSchedule(
    p: Principal,
    scheduleId: string,
  ): Promise<{
    seated: number;
    skipped: number;
    seatedStudents: number;
    unseatedStudents: number;
    overflow: Array<{ sittingId: string; title: string; hall: string; capacity: number; classSize: number; unseated: number }>;
    skippedReasons: { alreadySeated: number; noClass: number; emptyClass: number };
  }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sched = await tx.examSchedule.findFirst({ where: { id: scheduleId }, select: { id: true } });
      if (!sched) throw new NotFoundException("Schedule not found");
      const total = (await tx.examSitting.count({ where: { scheduleId } })) as number;
      const outcome = await this.autoSeatSchedule(tx, p.schoolId, scheduleId);
      const seated = outcome.seatedCount;
      const unseatedStudents = outcome.overflow.reduce((n, o) => n + o.unseated, 0);
      // Name the halls that came up short, so the officer can open another one.
      const overflowSittings = outcome.overflow.length
        ? ((await tx.examSitting.findMany({
            where: { id: { in: outcome.overflow.map((o) => o.sittingId) } },
            select: { id: true, title: true, hall: true },
          })) as Array<{ id: string; title: string; hall: string }>)
        : [];
      const nameOf = new Map(overflowSittings.map((x) => [x.id, x]));
      await this.audit.record(
        {
          actorId: p.userId,
          action: "exam.schedule.seat",
          entity: "exam_schedule",
          entityId: scheduleId,
          schoolId: p.schoolId,
          metadata: { seated, total, seatedStudents: outcome.seatedStudents, unseatedStudents, reasons: outcome.reasons },
        },
        tx,
      );
      return {
        seated,
        skipped: total - seated,
        seatedStudents: outcome.seatedStudents,
        unseatedStudents,
        overflow: outcome.overflow.map((o) => ({
          sittingId: o.sittingId,
          title: nameOf.get(o.sittingId)?.title ?? "",
          hall: nameOf.get(o.sittingId)?.hall ?? "",
          capacity: o.capacity,
          classSize: o.classSize,
          unseated: o.unseated,
        })),
        skippedReasons: outcome.reasons,
      };
    });
  }

  /** Auto-seat every student enrolled in a class into the sitting. */
  async seatClass(p: Principal, sittingId: string, classId: string): Promise<ExamSeatDto[]> {
    const studentIds = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const enr = await tx.enrollment.findMany({ where: { status: "ACTIVE", classId }, select: { studentId: true } });
      return enr.map((e: { studentId: string }) => e.studentId);
    });
    if (studentIds.length === 0) throw new BadRequestException("That class has no enrolled students");
    return this.seat(p, sittingId, studentIds);
  }

  async getSeatPlan(p: Principal, sittingId: string): Promise<ExamSeatDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.seatPlan(tx, sittingId));
  }

  private async seatPlan(tx: TenantTx, sittingId: string): Promise<ExamSeatDto[]> {
    const seats = await tx.examSeat.findMany({ where: { sittingId }, orderBy: { seatNo: "asc" } });
    const names = await this.userNames(tx, seats.map((s: { studentId: string }) => s.studentId));
    return seats.map((s: { studentId: string; seatNo: number }) => ({ studentId: s.studentId, studentName: names.get(s.studentId) ?? "", seatNo: s.seatNo }));
  }

  // --- staff: invigilation ----------------------------------------------------

  async assignInvigilator(p: Principal, sittingId: string, staffId: string, lead: boolean): Promise<InvigilationDto> {
    const outcome = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = await tx.examSitting.findFirst({ where: { id: sittingId }, select: { id: true, title: true, date: true, startsAt: true, endsAt: true, hall: true } });
      if (!sitting) throw new NotFoundException("Sitting not found");
      // Still employed, as well as staff. The clash check below exists so a
      // hall is never left unattended; rostering somebody who has left leaves
      // it unattended by a different route.
      await assertStillHere(tx, staffId, "Staff member");
      const staff = await tx.user.findFirst({ where: { id: staffId }, select: { id: true, name: true, roles: { select: { role: { select: { name: true } } } } } });
      if (!staff) throw new NotFoundException("Staff not found");
      const isStaff = staff.roles.some((r: { role: { name: string } }) => r.role.name !== "student" && r.role.name !== "parent");
      if (!isStaff) throw new BadRequestException("Only a staff member can invigilate");
      // Nobody can watch two halls at once. Checked here rather than left to the
      // roster-builder's memory, because the failure surfaces on exam morning with
      // one of the two halls simply unattended.
      await this.assertNoInvigilatorClash(tx, staffId, sitting);
      // Assignment rows are INSERT/DELETE only (rls/87 grants no UPDATE — a
      // roster change is a remove + re-add, so the history reads honestly).
      // Re-assigning the same staffer replaces the row rather than updating it.
      await tx.examInvigilator.deleteMany({ where: { sittingId, staffId } });
      await tx.examInvigilator.create({ data: { schoolId: p.schoolId, sittingId, staffId, lead } });
      await this.audit.record(
        { actorId: p.userId, action: "exam.invigilator.assign", entity: "exam_sitting", entityId: sittingId, schoolId: p.schoolId, metadata: { staffId, lead } },
        tx,
      );
      return { staff, sitting };
    });
    try {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: staffId,
        type: "GENERIC",
        title: "Invigilation duty assigned",
        body: `You're invigilating ${outcome.sitting.title} on ${this.dateOnly(outcome.sitting.date)} at ${outcome.sitting.startsAt} (${outcome.sitting.hall})${lead ? " — as lead" : ""}.`,
        data: { sittingId },
        channels: ["EMAIL"],
      });
    } catch {
      /* non-fatal */
    }
    return { sittingId, staffId, staffName: outcome.staff.name, lead };
  }

  async removeInvigilator(p: Principal, sittingId: string, staffId: string): Promise<{ removed: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const res = await tx.examInvigilator.deleteMany({ where: { sittingId, staffId } });
      if (res.count === 0) throw new NotFoundException("Not found");
      await this.audit.record(
        { actorId: p.userId, action: "exam.invigilator.remove", entity: "exam_sitting", entityId: sittingId, schoolId: p.schoolId, metadata: { staffId } },
        tx,
      );
      return { removed: true };
    });
  }

  async getInvigilators(p: Principal, sittingId: string): Promise<InvigilationDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.getInvigilatorsIn(tx, sittingId));
  }

  /** Roster read that works INSIDE an existing tx, so the attendance sheet can
   *  gather seats + roster + school in one read rather than reopening the tenant. */
  private async getInvigilatorsIn(tx: TenantTx, sittingId: string): Promise<InvigilationDto[]> {
    const rows = await tx.examInvigilator.findMany({ where: { sittingId }, orderBy: { lead: "desc" } });
    const names = await this.userNames(tx, rows.map((r: { staffId: string }) => r.staffId));
    return rows.map((r: { staffId: string; lead: boolean }) => ({ sittingId, staffId: r.staffId, staffName: names.get(r.staffId) ?? "", lead: r.lead }));
  }

  // --- the sitting's own register (append-only) --------------------------------

  /**
   * Who sat this exam: every seated student with their latest mark.
   *
   * `status: null` means NOT YET MARKED, which is deliberately distinct from
   * ABSENT. Conflating them would make an unmarked hall look like a hall where
   * everybody failed to turn up — and would quietly manufacture absence records
   * for pupils who were sitting there.
   */
  async getSittingAttendance(p: Principal, sittingId: string): Promise<ExamAttendanceDto> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const sitting = (await tx.examSitting.findFirst({
        where: { id: sittingId },
        select: { id: true, title: true, hall: true, date: true, startsAt: true, endsAt: true },
      })) as { id: string; title: string; hall: string; date: Date; startsAt: string; endsAt: string } | null;
      if (!sitting) throw new NotFoundException("Sitting not found");

      const seats = await this.seatPlan(tx, sittingId);
      // ONE query for the whole sitting's marks, newest first; the first row seen
      // per student is their current mark. Append-only means a student can have
      // several rows, so this is a fold, not a lookup — but it is still one read.
      const marks = (await tx.examAttendance.findMany({
        where: { sittingId },
        orderBy: { createdAt: "desc" },
        select: { studentId: true, status: true, note: true, markedById: true, createdAt: true },
      })) as Array<{ studentId: string; status: string; note: string | null; markedById: string; createdAt: Date }>;
      const latest = new Map<string, (typeof marks)[number]>();
      for (const m of marks) if (!latest.has(m.studentId)) latest.set(m.studentId, m);

      const markerNames = await this.userNames(tx, [...latest.values()].map((m) => m.markedById));

      const rows: ExamAttendanceRowDto[] = seats.map((s) => {
        const m = latest.get(s.studentId);
        return {
          studentId: s.studentId,
          studentName: s.studentName,
          seatNo: s.seatNo,
          status: m?.status ?? null,
          note: m?.note ?? null,
          markedByName: m ? markerNames.get(m.markedById) ?? null : null,
          markedAt: m ? m.createdAt.toISOString() : null,
        };
      });

      return {
        sittingId,
        title: sitting.title,
        hall: sitting.hall,
        date: this.dateOnly(sitting.date),
        startsAt: sitting.startsAt,
        endsAt: sitting.endsAt,
        rows,
        present: rows.filter((r) => r.status === "PRESENT").length,
        absent: rows.filter((r) => r.status === "ABSENT").length,
        unmarked: rows.filter((r) => r.status === null).length,
      };
    });
  }

  /**
   * Mark the sitting's register. Append-only: each call INSERTS rows, so a
   * correction is a new row and the previous mark stays visible in the history
   * rather than being silently overwritten.
   *
   * Only SEATED students can be marked — the seat plan is the definition of who was
   * expected, and marking someone who was never seated would create an absence for
   * a pupil who was never due to sit.
   *
   * This does NOT touch the daily class register. A pupil can be in school and miss
   * one exam, so writing ABSENT into that day's register would overwrite the class
   * teacher's mark with something it does not mean.
   */
  async markSittingAttendance(
    p: Principal,
    sittingId: string,
    entries: Array<{ studentId: string; status: string; note?: string | null }>,
  ): Promise<ExamAttendanceDto> {
    if (entries.length === 0) throw new BadRequestException("Nothing to mark");
    await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const sitting = await tx.examSitting.findFirst({ where: { id: sittingId }, select: { id: true } });
      if (!sitting) throw new NotFoundException("Sitting not found");

      const seated = (await tx.examSeat.findMany({ where: { sittingId }, select: { studentId: true } })) as Array<{ studentId: string }>;
      const seatedIds = new Set(seated.map((s) => s.studentId));
      if (seatedIds.size === 0) {
        throw new ConflictException("Nobody is seated for this sitting yet — seat the class before taking its register");
      }
      // De-duplicate within the request (last wins) so one submission can't write
      // two contradictory marks for the same student in the same instant.
      const byStudent = new Map<string, { studentId: string; status: string; note?: string | null }>();
      for (const e of entries) {
        if (!seatedIds.has(e.studentId)) {
          throw new BadRequestException("A student who is not seated for this sitting cannot be marked");
        }
        if (e.status !== "PRESENT" && e.status !== "ABSENT") {
          throw new BadRequestException('status must be "PRESENT" or "ABSENT"');
        }
        byStudent.set(e.studentId, e);
      }

      await tx.examAttendance.createMany({
        data: [...byStudent.values()].map((e) => ({
          schoolId: p.schoolId,
          sittingId,
          studentId: e.studentId,
          status: e.status,
          note: e.note ?? null,
          markedById: p.userId,
        })),
      });

      const absent = [...byStudent.values()].filter((e) => e.status === "ABSENT").length;
      await this.audit.record(
        {
          actorId: p.userId,
          action: "exam.attendance.mark",
          entity: "exam_sitting",
          entityId: sittingId,
          schoolId: p.schoolId,
          metadata: { marked: byStudent.size, absent },
        },
        tx,
      );
    });
    return this.getSittingAttendance(p, sittingId);
  }

  /** Absent/unmarked tallies for a set of sittings, batched — feeds the day board. */
  private async attendanceTallies(
    tx: TenantTx,
    sittingIds: string[],
  ): Promise<Map<string, { absent: number; marked: number }>> {
    const out = new Map<string, { absent: number; marked: number }>();
    if (sittingIds.length === 0) return out;
    // Append-only means "latest row per student" can't be a plain groupBy, so fold
    // in Node — but still from ONE query for every sitting on the board.
    const rows = (await tx.examAttendance.findMany({
      where: { sittingId: { in: sittingIds } },
      orderBy: { createdAt: "desc" },
      select: { sittingId: true, studentId: true, status: true },
    })) as Array<{ sittingId: string; studentId: string; status: string }>;
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.sittingId}:${r.studentId}`;
      if (seen.has(key)) continue; // an older, superseded mark
      seen.add(key);
      const cur = out.get(r.sittingId) ?? { absent: 0, marked: 0 };
      cur.marked += 1;
      if (r.status === "ABSENT") cur.absent += 1;
      out.set(r.sittingId, cur);
    }
    return out;
  }

  // --- the hall pack: printable seating chart + attendance sheet ---------------

  /**
   * The sheet the invigilator physically carries into the hall: who sits where, a
   * signature column, and a place to record absentees.
   *
   * The seat plan and roster were already stored and already had endpoints — they
   * were simply never reachable, so the one artefact the whole seating exercise
   * exists to produce could not be printed. Halls run on paper on exam day: the
   * network is the first thing to fail and a signature column is the attendance
   * record that gets archived.
   *
   * Audited, because it lists the names of minors sitting a specific exam.
   */
  async attendanceSheetPdf(p: Principal, sittingId: string): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const sitting = (await tx.examSitting.findFirst({ where: { id: sittingId } })) as SittingRow | null;
      // 404 not 403 — a cross-tenant id must not confirm the sitting exists.
      if (!sitting) throw new NotFoundException("Sitting not found");
      const [seats, invigilators, school, cls, marks] = await Promise.all([
        this.seatPlan(tx, sittingId),
        this.getInvigilatorsIn(tx, sittingId),
        tx.school.findFirst({ where: { id: p.schoolId }, select: { name: true } }) as Promise<{ name: string } | null>,
        sitting.classId
          ? (tx.class.findFirst({ where: { id: sitting.classId }, select: { name: true } }) as Promise<{ name: string } | null>)
          : Promise.resolve(null),
        tx.examAttendance.findMany({
          where: { sittingId },
          orderBy: { createdAt: "desc" },
          select: { studentId: true, status: true },
        }) as Promise<Array<{ studentId: string; status: string }>>,
      ]);
      // Marks already recorded are PRINTED onto the sheet, so the paper round-trips:
      // print blank -> mark in the hall -> enter -> reprint as the filed record.
      // Without this the archived copy would always look untaken.
      const latest = new Map<string, string>();
      for (const m of marks) if (!latest.has(m.studentId)) latest.set(m.studentId, m.status);
      return { sitting, seats, invigilators, schoolName: school?.name ?? "", className: cls?.name ?? null, marks: latest };
    });

    await this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.audit.record(
        {
          actorId: p.userId,
          action: "exam.attendance_sheet.print",
          entity: "exam_sitting",
          entityId: sittingId,
          schoolId: p.schoolId,
          metadata: { seats: data.seats.length },
        },
        tx,
      );
    });

    const buffer = await this.renderAttendanceSheet(data);
    const safe = `${data.sitting.title}-${this.dateOnly(data.sitting.date)}`.replace(/[^a-zA-Z0-9-_]+/g, "_");
    return { buffer, filename: `attendance-${safe}.pdf` };
  }

  private async renderAttendanceSheet(d: {
    sitting: SittingRow;
    seats: ExamSeatDto[];
    invigilators: InvigilationDto[];
    schoolName: string;
    className: string | null;
    marks: Map<string, string>;
  }): Promise<Buffer> {
    const { default: PDFDocument } = await import("pdfkit");
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;

      doc.fontSize(14).text(d.schoolName, { align: "center" });
      doc.fontSize(11).text("EXAMINATION ATTENDANCE SHEET", { align: "center" });
      doc.moveDown(0.6);

      doc.fontSize(10);
      const meta = [
        `Exam: ${d.sitting.title}${d.sitting.subject ? ` (${d.sitting.subject})` : ""}`,
        d.className ? `Class: ${d.className}` : null,
        `Date: ${this.dateOnly(d.sitting.date)}    Time: ${d.sitting.startsAt}–${d.sitting.endsAt}`,
        `Hall: ${d.sitting.hall}${d.sitting.capacity > 0 ? ` (capacity ${d.sitting.capacity})` : ""}`,
        `Seated: ${d.seats.length}`,
        d.invigilators.length
          ? `Invigilator(s): ${d.invigilators.map((i) => `${i.staffName}${i.lead ? " (lead)" : ""}`).join(", ")}`
          : "Invigilator(s): __________________________  (NONE ROSTERED)",
      ].filter(Boolean) as string[];
      for (const line of meta) doc.text(line);
      doc.moveDown(0.5);

      // Column layout. Signature is deliberately the widest column — it is the
      // thing being collected; everything else is context for finding the row.
      const cols = [
        { label: "Seat", w: 40 },
        { label: "Student", w: 200 },
        { label: "Signature", w: 190 },
        { label: "Absent", w: 45 },
      ];
      const rowH = 22;

      const header = (y: number): number => {
        let x = left;
        doc.fontSize(9);
        for (const c of cols) {
          doc.rect(x, y, c.w, rowH).stroke();
          doc.text(c.label, x + 4, y + 7, { width: c.w - 8 });
          x += c.w;
        }
        return y + rowH;
      };

      let y = header(doc.y);
      for (const s of d.seats) {
        // Page break BEFORE drawing, and re-draw the header — a continuation page
        // of unlabelled boxes is unusable in a hall.
        if (y + rowH > doc.page.height - doc.page.margins.bottom - 60) {
          doc.addPage();
          y = header(doc.page.margins.top);
        }
        let x = left;
        // A mark already in the system is printed: "PRESENT" fills the signature
        // box (it is already attested digitally, so re-signing adds nothing) and an
        // absence is stamped in the Absent column. An UNMARKED row stays blank, so
        // a blank sheet is still what you print to take the register on paper.
        const mark = d.marks.get(s.studentId);
        const cells = [
          String(s.seatNo),
          s.studentName,
          mark === "PRESENT" ? "recorded present" : "",
          mark === "ABSENT" ? "ABSENT" : "",
        ];
        for (let i = 0; i < cols.length; i++) {
          doc.rect(x, y, cols[i]!.w, rowH).stroke();
          if (cells[i]) doc.fontSize(9).text(cells[i]!, x + 4, y + 7, { width: cols[i]!.w - 8, ellipsis: true });
          x += cols[i]!.w;
        }
        y += rowH;
      }

      if (d.seats.length === 0) {
        doc.fontSize(9).text("No students seated for this sitting.", left, y + 8);
        y += 24;
      }

      doc.moveDown(1.5);
      doc.fontSize(9).text(`Total present: ____________     Total absent: ____________`, left, Math.max(y + 18, doc.y));
      doc.moveDown(1.2);
      doc.text("Invigilator signature: ______________________________", left);
      doc.moveDown(0.4);
      doc.text(`Printed ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, left, undefined, { width: right - left });

      doc.end();
    });
  }

  // --- student / parent: my exams ---------------------------------------------

  /** Upcoming sittings where the caller (or their child) has a seat. */
  async myExams(p: Principal): Promise<MyExamDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const studentIds = new Set<string>();
      if (p.roles.includes("student")) studentIds.add(p.userId);
      const kids = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
      kids.forEach((k: { studentId: string }) => studentIds.add(k.studentId));
      if (studentIds.size === 0) return [];
      const seats = await tx.examSeat.findMany({
        where: {
          studentId: { in: [...studentIds] },
          // BOUNDED both ways. "Upcoming" with no upper edge meant a parent of
          // three children pulled every seat ever scheduled into the future; the
          // horizon below covers a term, which is as far ahead as a schedule is
          // ever published.
          sitting: { date: { gte: await this.region.todayInTx(tx, p.schoolId), lte: MY_EXAMS_HORIZON() } },
        },
        include: { sitting: { select: { title: true, subject: true, date: true, startsAt: true, endsAt: true, hall: true } } },
        orderBy: { sitting: { date: "asc" } },
        take: MY_EXAMS_MAX,
      });
      const names = await this.userNames(tx, seats.map((s: { studentId: string }) => s.studentId));
      return seats
        .map((s: SeatWithSitting) => ({
          studentId: s.studentId,
          studentName: names.get(s.studentId) ?? "",
          title: s.sitting.title,
          subject: s.sitting.subject,
          date: this.dateOnly(s.sitting.date),
          startsAt: s.sitting.startsAt,
          endsAt: s.sitting.endsAt,
          hall: s.sitting.hall,
          seatNo: s.seatNo,
        }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startsAt.localeCompare(b.startsAt));
    });
  }

  /** Staff: the sittings the caller is rostered to invigilate. */
  async myInvigilations(p: Principal): Promise<MyExamDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.examInvigilator.findMany({
        where: {
          staffId: p.userId,
          sitting: { date: { gte: await this.region.todayInTx(tx, p.schoolId), lte: MY_EXAMS_HORIZON() } },
        },
        include: { sitting: { select: { title: true, subject: true, date: true, startsAt: true, endsAt: true, hall: true } } },
        orderBy: { sitting: { date: "asc" } },
        take: MY_EXAMS_MAX,
      });
      return rows
        .map((r: { lead: boolean; sitting: { title: string; subject: string | null; date: Date; startsAt: string; endsAt: string; hall: string } }) => ({
          studentId: "",
          studentName: r.lead ? "Lead invigilator" : "Invigilator",
          title: r.sitting.title,
          subject: r.sitting.subject,
          date: this.dateOnly(r.sitting.date),
          startsAt: r.sitting.startsAt,
          endsAt: r.sitting.endsAt,
          hall: r.sitting.hall,
          seatNo: 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startsAt.localeCompare(b.startsAt));
    });
  }

  // --- helpers ----------------------------------------------------------------

  private async countBy(tx: TenantTx, model: "examSeat" | "examInvigilator", field: "sittingId", ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const grouped = await (tx as unknown as Record<string, { groupBy: (a: unknown) => Promise<{ sittingId: string; _count: { _all: number } }[]> }>)[model].groupBy({
      by: [field],
      where: { [field]: { in: ids } },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.sittingId, g._count._all]));
  }

  private async userNames(tx: TenantTx, ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (uniq.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map<string, string>(users.map((u: { id: string; name: string }) => [u.id, u.name] as const));
  }

  private toSittingDto(
    s: SittingRow,
    seated: number,
    invigilators: number,
    cbt: { status: string | null; released: boolean; started: number; submitted: number },
    className: string | null,
  ): ExamSittingDto {
    return {
      id: s.id,
      title: s.title,
      subject: s.subject,
      date: this.dateOnly(s.date),
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      hall: s.hall,
      roomId: s.roomId,
      capacity: s.capacity,
      note: s.note,
      classId: s.classId,
      className,
      seated,
      invigilators,
      scheduleId: s.scheduleId,
      cbtExamId: s.cbtExamId,
      cbtStatus: cbt.status,
      released: cbt.released,
      started: cbt.started,
      submitted: cbt.submitted,
    };
  }
}

type SittingRow = {
  id: string;
  title: string;
  subject: string | null;
  date: Date;
  startsAt: string;
  endsAt: string;
  hall: string;
  roomId: string | null;
  capacity: number;
  note: string | null;
  classId: string | null;
  scheduleId: string | null;
  cbtExamId: string | null;
};
type SeatWithSitting = { studentId: string; seatNo: number; sitting: { title: string; subject: string | null; date: Date; startsAt: string; endsAt: string; hall: string } };
