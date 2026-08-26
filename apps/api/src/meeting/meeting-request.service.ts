// =============================================================================
// MeetingRequestService — a parent asks, the TEACHER answers
// =============================================================================
// A parent could previously only book a slot a teacher had already opened. This
// is the other direction, and the routing is the whole design:
//
//   the TEACHER decides            they own the time being asked for
//   leadership SEES everything     oversight without a step in the middle
//   leadership DECIDES on exception a CONCERN, or a school that opted in
//
// Accepting does not invent a second kind of meeting: it opens an ordinary slot
// with a STUDENT audience and books the parent into it, so the join window,
// the notification and the record all come from the code that already runs
// every parent-teacher meeting.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  MEETING_REQUEST_STALE_DAYS,
  MEETING_REQUEST_STATUS_LABELS,
  MEETING_REQUEST_TOPIC_LABELS,
  initialRequestStatus,
  isOpenRequest,
  type MeetingRequestDto,
  type MeetingRequestPageDto,
  type MeetingRequestStatus,
} from "@sms/types";
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
import { asDuplicateConflict } from "../common/unique-violation";

/** Who may see every request and act on the leadership stage. */
const LEADERSHIP = new Set(["school_admin", "principal", "head_teacher"]);

/** The two statuses that mean a family is still waiting on an answer. */
const OPEN_REQUEST_STATUSES = ["PENDING_APPROVAL", "PENDING_TEACHER"] as const;
const REQUEST_PAGE_SIZE = 50;

type RequestRow = {
  id: string;
  parentId: string;
  studentId: string;
  teacherId: string;
  topic: string;
  note: string | null;
  status: string;
  decidedById: string | null;
  decisionNote: string | null;
  slotId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class MeetingRequestService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isLeadership(p: Principal): boolean {
    return p.roles.some((r) => LEADERSHIP.has(r));
  }

  /**
   * A parent asks a teacher for a meeting about their own child.
   *
   * Both relationships are checked, and they are different checks: the pupil
   * must be THEIRS, and the teacher must actually teach or supervise that
   * pupil's class. Without the second, a parent could address any member of
   * staff in the school about their child — including one who has never met
   * them.
   */
  async create(
    p: Principal,
    input: { studentId: string; teacherId: string; topic: string; note?: string | null },
  ): Promise<MeetingRequestDto> {
    if (!MEETING_REQUEST_TOPIC_LABELS[input.topic as keyof typeof MEETING_REQUEST_TOPIC_LABELS]) {
      throw new BadRequestException("Choose what the meeting is about.");
    }
    // The guard below is the sentence a user reads; a unique index is what
    // makes it true when two requests arrive together. Translated so the loser
    // of that race is told the same thing, with the same status, as somebody
    // who simply pressed second.
    const created = await asDuplicateConflict('You already have a request open with that teacher.', () =>
      this.db.runAsTenant(this.ctx(p), async (tx) => {
      const mine = await tx.parentChild.findFirst({
        where: { parentId: p.userId, studentId: input.studentId },
        select: { id: true },
      });
      // 404, not 403: never confirm that a pupil exists to somebody unrelated.
      if (!mine) throw new NotFoundException("Pupil not found");

      const classes = (await tx.enrollment.findMany({
        where: { studentId: input.studentId, status: "ACTIVE" },
        select: { classId: true },
      })) as Array<{ classId: string }>;
      const classIds = classes.map((c) => c.classId);
      if (classIds.length === 0) throw new BadRequestException("That pupil is not enrolled in a class yet.");

      const [teaches, supervises] = await Promise.all([
        tx.classSubjectTeacher.findFirst({
          where: { classId: { in: classIds }, teacherId: input.teacherId },
          select: { id: true },
        }),
        tx.class.findFirst({ where: { id: { in: classIds }, supervisorId: input.teacherId }, select: { id: true } }),
      ]);
      if (!teaches && !supervises) throw new NotFoundException("That teacher does not teach your child.");

      // One open request per (parent, child, teacher). Without this, a parent
      // waiting on a slow reply re-asks, and the teacher's inbox fills with the
      // same conversation.
      const already = await tx.meetingRequest.findFirst({
        where: {
          parentId: p.userId,
          studentId: input.studentId,
          teacherId: input.teacherId,
          status: { in: ["PENDING_APPROVAL", "PENDING_TEACHER"] },
        },
        select: { id: true },
      });
      if (already) throw new ConflictException("You already have a request open with that teacher.");

      // The school's own setting — read here, not cached, because it decides
      // where the request lands and a stale answer routes it to the wrong desk.
      const school = (await tx.school.findFirst({
        where: { id: p.schoolId },
        select: { requireMeetingApproval: true },
      })) as { requireMeetingApproval: boolean } | null;
      const status = initialRequestStatus(input.topic, school?.requireMeetingApproval ?? false);

      const row = (await tx.meetingRequest.create({
        data: {
          schoolId: p.schoolId,
          parentId: p.userId,
          studentId: input.studentId,
          teacherId: input.teacherId,
          topic: input.topic,
          note: input.note?.trim() || null,
          status,
        },
      })) as RequestRow;
      await this.log(tx, p, "meeting.request.create", row.id, { topic: input.topic, status });
      return row;
      }),
    );

    // Told AFTER commit: a notification failure must not lose the request.
    await this.tell(p, created, created.status === "PENDING_APPROVAL" ? "leadership" : "teacher");
    return this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.toDto(tx, created));
  }

  /**
   * The requests this caller may see.
   *
   * `filter=open` is the QUEUE and comes back OLDEST FIRST — the family that
   * has been waiting longest is the one to answer next. Anything else is
   * newest-first, which is what a history wants.
   *
   * // GOTCHA: the SQL narrowing below has always existed and its ONE caller
   * never used it — the meetings page fetched the unfiltered `take: 200` and
   * split it with `requests.filter(r => r.status === "PENDING_…")`. A request
   * is pending because nobody has answered it, so the unanswered ones age off
   * the end of a newest-first cap: the rows the split existed to surface were
   * the rows it could not see. Same defect as the subject-selection queue and
   * as the chargeback banner before it.
   */
  async list(
    p: Principal,
    opts: { filter?: "open" | "decided"; page?: number } = {},
  ): Promise<MeetingRequestPageDto> {
    const pageSize = REQUEST_PAGE_SIZE;
    const page = Math.max(1, opts.page ?? 1);
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      // Each audience gets its own indexed slice — nobody reads the school's
      // whole history to find their own three rows.
      const scope: Record<string, unknown> = this.isLeadership(p)
        ? {}
        : { OR: [{ parentId: p.userId }, { teacherId: p.userId }] };
      const byFilter =
        opts.filter === "open"
          ? { status: { in: [...OPEN_REQUEST_STATUSES] } }
          : opts.filter === "decided"
            ? { status: { notIn: [...OPEN_REQUEST_STATUSES] } }
            : {};
      const where = { ...scope, ...byFilter };
      const [rows, total, pendingTotal] = await Promise.all([
        tx.meetingRequest.findMany({
          where,
          orderBy: opts.filter === "open" ? { createdAt: "asc" } : { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }) as Promise<RequestRow[]>,
        tx.meetingRequest.count({ where }),
        // Never narrowed by the filter — it answers "is a family waiting on us".
        tx.meetingRequest.count({ where: { ...scope, status: { in: [...OPEN_REQUEST_STATUSES] } } }),
      ]);
      return { items: await this.toDtos(tx, rows), total, pendingTotal, page, pageSize };
    });
  }

  /**
   * Leadership passes a request on to the teacher (or refuses it).
   *
   * This stage only exists for a CONCERN or a school that opted in, so the
   * common path never reaches here.
   */
  async review(p: Principal, id: string, action: "PASS" | "DECLINE", note?: string): Promise<MeetingRequestDto> {
    if (!this.isLeadership(p)) throw new NotFoundException("Request not found");
    const row = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = (await tx.meetingRequest.findFirst({ where: { id } })) as RequestRow | null;
      if (!r) throw new NotFoundException("Request not found");
      if (r.status !== "PENDING_APPROVAL") throw new ConflictException(`That request is already ${r.status.toLowerCase()}.`);
      const status: MeetingRequestStatus = action === "PASS" ? "PENDING_TEACHER" : "DECLINED";
      // Optimistic claim: two reviewers acting at once must not both win.
      const written = await tx.meetingRequest.updateMany({
        where: { id, status: "PENDING_APPROVAL" },
        data: { status, decidedById: p.userId, decisionNote: note?.trim() || null },
      });
      if (written.count === 0) throw new ConflictException("Somebody else just answered that request.");
      await this.log(tx, p, "meeting.request.review", id, { action });
      return { ...r, status, decidedById: p.userId, decisionNote: note?.trim() || null };
    });
    await this.tell(p, row, row.status === "PENDING_TEACHER" ? "teacher" : "parent");
    return this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.toDto(tx, row));
  }

  /**
   * The teacher answers. ACCEPT opens the meeting; DECLINE must say why.
   *
   * A decline with no reason tells the parent nothing and is the commonest
   * cause of the same request arriving again a week later.
   */
  async decide(
    p: Principal,
    id: string,
    input: { action: "ACCEPT" | "DECLINE"; startsAt?: string; endsAt?: string; note?: string },
  ): Promise<MeetingRequestDto> {
    if (input.action === "DECLINE" && !input.note?.trim()) {
      throw new BadRequestException("Say why, so the parent knows what to do next.");
    }
    const row = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = (await tx.meetingRequest.findFirst({ where: { id } })) as RequestRow | null;
      if (!r) throw new NotFoundException("Request not found");
      // Leadership may answer on a teacher's behalf — that is the escalation
      // path when a teacher has left or is on leave.
      if (r.teacherId !== p.userId && !this.isLeadership(p)) throw new NotFoundException("Request not found");
      if (r.status !== "PENDING_TEACHER") throw new ConflictException(`That request is already ${r.status.toLowerCase()}.`);

      let slotId: string | null = null;
      if (input.action === "ACCEPT") {
        if (!input.startsAt || !input.endsAt) throw new BadRequestException("Choose a time for the meeting.");
        const startsAt = new Date(input.startsAt);
        const endsAt = new Date(input.endsAt);
        if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
          throw new BadRequestException("The meeting must end after it starts.");
        }
        // An ordinary slot, audienced at the pupil, with the parent already
        // booked in. Reusing the slot model means the join window, the reminder
        // and the record all behave exactly as every other meeting does.
        const slot = (await tx.meetingSlot.create({
          data: {
            schoolId: p.schoolId,
            teacherId: r.teacherId,
            startsAt,
            endsAt,
            capacity: 1,
            kind: "APPOINTMENT",
            audienceKind: "STUDENT",
            audienceRef: r.studentId,
            note: r.note,
          },
        })) as { id: string };
        slotId = slot.id;
        await tx.meetingBooking.create({
          data: { schoolId: p.schoolId, slotId: slot.id, parentId: r.parentId, studentId: r.studentId, status: "BOOKED" },
        });
      }

      const status: MeetingRequestStatus = input.action === "ACCEPT" ? "ACCEPTED" : "DECLINED";
      const written = await tx.meetingRequest.updateMany({
        where: { id, status: "PENDING_TEACHER" },
        data: { status, decidedById: p.userId, decisionNote: input.note?.trim() || null, slotId },
      });
      if (written.count === 0) throw new ConflictException("Somebody else just answered that request.");
      await this.log(tx, p, "meeting.request.decide", id, { action: input.action, slotId });
      return { ...r, status, decidedById: p.userId, decisionNote: input.note?.trim() || null, slotId };
    });
    await this.tell(p, row, "parent");
    return this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.toDto(tx, row));
  }

  /** The parent withdraws. A CANCELLED row stays: withdrawing an ask is not the
   *  same as it never having happened, which matters most for a concern. */
  async cancel(p: Principal, id: string): Promise<MeetingRequestDto> {
    const row = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const r = (await tx.meetingRequest.findFirst({ where: { id } })) as RequestRow | null;
      if (!r || r.parentId !== p.userId) throw new NotFoundException("Request not found");
      if (!isOpenRequest(r.status)) throw new ConflictException(`That request is already ${r.status.toLowerCase()}.`);
      await tx.meetingRequest.updateMany({ where: { id, status: r.status }, data: { status: "CANCELLED" } });
      await this.log(tx, p, "meeting.request.cancel", id, {});
      return { ...r, status: "CANCELLED" as MeetingRequestStatus };
    });
    return this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.toDto(tx, row));
  }

  // --- helpers ---------------------------------------------------------------

  private staleAfter(): Date {
    return new Date(Date.now() - MEETING_REQUEST_STALE_DAYS * 24 * 60 * 60 * 1000);
  }

  private async toDto(tx: TenantTx, row: RequestRow): Promise<MeetingRequestDto> {
    return (await this.toDtos(tx, [row]))[0];
  }

  /** Names resolved in ONE batched lookup for the whole list — the scalar-FK
   *  pattern means they never arrive on the row. */
  private async toDtos(tx: TenantTx, rows: RequestRow[]): Promise<MeetingRequestDto[]> {
    if (rows.length === 0) return [];
    const ids = [
      ...new Set(rows.flatMap((r) => [r.parentId, r.studentId, r.teacherId, r.decidedById].filter((x): x is string => !!x))),
    ];
    const users = (await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as Array<{
      id: string;
      name: string;
    }>;
    const name = new Map(users.map((u) => [u.id, u.name]));
    const cutoff = this.staleAfter();
    return rows.map((r) => ({
      id: r.id,
      studentId: r.studentId,
      studentName: name.get(r.studentId) ?? "Unknown",
      parentId: r.parentId,
      parentName: name.get(r.parentId) ?? "Unknown",
      teacherId: r.teacherId,
      teacherName: name.get(r.teacherId) ?? "Unknown",
      topic: r.topic,
      topicLabel: MEETING_REQUEST_TOPIC_LABELS[r.topic as keyof typeof MEETING_REQUEST_TOPIC_LABELS] ?? r.topic,
      note: r.note,
      status: r.status as MeetingRequestStatus,
      statusLabel: MEETING_REQUEST_STATUS_LABELS[r.status as MeetingRequestStatus] ?? r.status,
      slotId: r.slotId,
      decisionNote: r.decisionNote,
      decidedByName: r.decidedById ? (name.get(r.decidedById) ?? null) : null,
      stale: isOpenRequest(r.status) && r.createdAt < cutoff,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /** Never throws: the request is the durable record, a notification is not. */
  private async tell(p: Principal, row: RequestRow, to: "teacher" | "parent" | "leadership"): Promise<void> {
    try {
      await this.db.runAsTenant(this.ctx(p), async (tx) => {
        const recipients =
          to === "teacher"
            ? [row.teacherId]
            : to === "parent"
              ? [row.parentId]
              : ((await tx.userRole.findMany({
                  where: { role: { name: { in: [...LEADERSHIP] } } },
                  select: { userId: true },
                  distinct: ["userId"],
                })) as Array<{ userId: string }>).map((u) => u.userId);
        if (recipients.length === 0) return;
        const title =
          to === "parent"
            ? row.status === "ACCEPTED"
              ? "Your meeting request was accepted"
              : "Your meeting request was answered"
            : "A parent has asked for a meeting";
        await this.notifications.enqueueMany({ schoolId: p.schoolId, userId: p.userId }, recipients, {
          type: "MEETING",
          title,
          body: row.decisionNote ?? row.note ?? "Open your meetings page for the details.",
          data: { requestId: row.id, slotId: row.slotId },
        } as never);
      });
    } catch {
      // Swallowed deliberately — see above.
    }
  }

  private async log(tx: TenantTx, p: Principal, action: string, entityId: string, metadata: Record<string, unknown>) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "meeting_request", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
