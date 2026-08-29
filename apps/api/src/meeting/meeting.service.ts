// =============================================================================
// MeetingService — parent-teacher appointment slots + bookings
// =============================================================================
// A teacher (or staff) opens time slots; a parent books one for one of their
// OWN children (relationship-checked). An APPOINTMENT slot is claimed atomically:
// the slot row is locked FOR UPDATE before the capacity count, so two parents
// pressing Book on the last half-hour cannot both get it. (This comment used to
// describe an optimistic updateMany claim that was not in the code — the check
// was a plain count-then-insert, and saying otherwise is part of why nobody
// looked.) A BRIEFING deliberately claims nothing; see `book`. Both parties are
// notified on book and cancel. Reads are scoped: a teacher sees their own slots + bookings; a parent
// sees open slots and their own bookings.
// =============================================================================

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { STILL_HERE } from "../common/still-here";
import type { MeetingSlotDto, MeetingBookingDto } from "@sms/types";
import { MEETING_PROVIDERS, isMeetingJoinOpen, meetingJoinOpensAt, normalizeMeetingUrl,
  SUBJECT_STAGES,
  meetingAudienceProblem,
  type MeetingAudience,
  describeAudience,
  type MeetingAudienceKind,
  isAppointment,
  NON_STAFF_ROLE_NAMES,
  MEETING_PERMISSIONS,
  parseStreamRef,
  streamAudienceRef,
  CLASS_STREAM_LABELS,
} from "@sms/types";
import type { MeetingProvider } from "@sms/types";
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

/** Guardians told per transaction. Small enough that each is a short
 *  transaction, large enough that a year group is a handful of them. */
const ANNOUNCE_CHUNK = 200;

const STAGE_LABELS: Record<string, string> = {
  PRE_PRIMARY: "Pre-primary",
  PRIMARY: "Primary",
  JUNIOR_SECONDARY: "Junior Secondary",
  SENIOR_SECONDARY: "Senior Secondary",
};

const STAFF_WIDE = new Set(["school_admin", "principal"]);

/** "SS3 Science" — the one place a stream is turned into words, so the picker,
 *  the notification and the slot row cannot describe it differently. */
function streamRefLabel(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const parsed = parseStreamRef(ref);
  return parsed ? streamLabel(parsed.stage, parsed.level, parsed.stream) : null;
}

function streamLabel(stage: string | null, level: number | null, stream: string | null): string {
  const prefix = stage === "SENIOR_SECONDARY" ? "SS" : stage === "JUNIOR_SECONDARY" ? "JSS" : (STAGE_LABELS[stage ?? ""] ?? "");
  const year = level == null ? "" : `${prefix === "SS" || prefix === "JSS" ? "" : " "}${level}`;
  const name = stream ? ` ${CLASS_STREAM_LABELS[stream as keyof typeof CLASS_STREAM_LABELS] ?? stream}` : "";
  return `${prefix}${year}${name}`.trim();
}

@Injectable()
export class MeetingService {
  private readonly logger = new Logger("Meeting");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly notifications: NotificationService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- teacher: manage slots --------------------------------------------------

  /** Open a slot. A teacher opens their OWN; staff-wide may open for any teacher. */
  /**
   * The pupil, class or year group named by an audience must EXIST and be
   * something this host may address.
   *
   * Without this a typo'd uuid produces a meeting nobody is invited to — which
   * looks identical to one nobody has booked, and would be discovered by an
   * empty room.
   */
  private async assertAudienceExists(
    tx: TenantTx,
    p: Principal,
    a: MeetingAudience,
    staffWide: boolean,
    // Returns the NAME it just verified: this method already loads the row to
    // prove it exists, so making the label cost a second query would be waste.
  ): Promise<{ className: string | null; studentName: string | null }> {
    const none = { className: null, studentName: null };
    // SCHOOL names nothing. SELECTED names nothing HERE either — its people are
    // validated against parentChild where they are written, not through `ref`.
    // Falling through to the STUDENT branch made this query `where: { id: null }`.
    if (a.kind === "SCHOOL" || a.kind === "SELECTED") return none;
    if (a.kind === "STAGE") {
      if (!(SUBJECT_STAGES as readonly string[]).includes(a.ref!)) {
        throw new BadRequestException(`Year group must be one of ${SUBJECT_STAGES.join(", ")}`);
      }
      return none;
    }
    if (a.kind === "STREAM") {
      const parsed = parseStreamRef(a.ref!);
      if (!parsed) throw new BadRequestException("That stream is not a valid year-and-stream.");
      // It must be a stream the school actually runs — otherwise the meeting is
      // announced to nobody and looks sent.
      const any = await tx.class.findFirst({
        where: { stage: parsed.stage, level: parsed.level, stream: parsed.stream },
        select: { id: true },
      });
      if (!any) throw new NotFoundException("No classes in that stream");
      return none;
    }
    if (a.kind === "CLASS") {
      const klass = (await tx.class.findFirst({ where: { id: a.ref! }, select: { id: true, name: true } })) as { id: string; name: string } | null;
      if (!klass) throw new NotFoundException("Class not found");
      if (staffWide) return { className: klass.name, studentName: null };
      // A teacher may call their OWN class's parents together — the class they
      // supervise or teach a subject to — and no other.
      const [supervises, teaches] = await Promise.all([
        tx.class.findFirst({ where: { id: a.ref!, supervisorId: p.userId }, select: { id: true } }),
        tx.classSubjectTeacher.findFirst({ where: { classId: a.ref!, teacherId: p.userId }, select: { id: true } }),
      ]);
      if (!supervises && !teaches) throw new NotFoundException("Class not found");
      return { className: klass.name, studentName: null };
    }
    // STUDENT: the pupil must exist. Any teacher may offer an appointment about
    // any pupil they are asked about, so this checks existence, not membership.
    const student = (await tx.user.findFirst({ where: { id: a.ref! }, select: { id: true, name: true } })) as { id: string; name: string } | null;
    if (!student) throw new NotFoundException("Student not found");
    return { className: null, studentName: student.name };
  }

  /**
   * The guardians an audience resolves to.
   *
   * THE ONE PLACE resolution happens, and it happens only when a meeting is
   * ANNOUNCED — never to render a page. Everything else in this file works from
   * the rule outwards, which is what keeps the parent's list to a single indexed
   * query no matter how large the school is.
   *
   * Returns distinct parent ids. A guardian with three children in a year group
   * is told once, not three times.
   */
  private async resolveAudience(tx: TenantTx, a: MeetingAudience, slotId?: string): Promise<string[]> {
    // SELECTED is the one kind whose people are STORED rather than derived —
    // there is no rule to derive a hand-picked set from.
    if (a.kind === "SELECTED") {
      const rows = (await tx.meetingInvitee.findMany({
        where: { slotId: slotId! },
        select: { parentId: true },
      })) as Array<{ parentId: string }>;
      return [...new Set(rows.map((r) => r.parentId))];
    }
    let studentIds: string[] | null = null; // null = every pupil in the school
    if (a.kind === "STUDENT") {
      studentIds = [a.ref!];
    } else if (a.kind === "CLASS") {
      const rows = (await tx.enrollment.findMany({
        where: { classId: a.ref!, status: "ACTIVE" },
        select: { studentId: true },
      })) as Array<{ studentId: string }>;
      studentIds = rows.map((r) => r.studentId);
    } else if (a.kind === "STREAM") {
      // Every arm of the stream, in one indexed read on
      // (schoolId, stage, level, stream).
      const parsed = parseStreamRef(a.ref!);
      if (!parsed) return [];
      const classes = (await tx.class.findMany({
        where: { stage: parsed.stage, level: parsed.level, stream: parsed.stream },
        select: { id: true },
      })) as Array<{ id: string }>;
      if (classes.length === 0) return [];
      const rows = (await tx.enrollment.findMany({
        where: { classId: { in: classes.map((c) => c.id) }, status: "ACTIVE" },
        select: { studentId: true },
      })) as Array<{ studentId: string }>;
      studentIds = rows.map((r) => r.studentId);
    } else if (a.kind === "STAGE") {
      const classes = (await tx.class.findMany({ where: { stage: a.ref! }, select: { id: true } })) as Array<{ id: string }>;
      if (classes.length === 0) return [];
      const rows = (await tx.enrollment.findMany({
        where: { classId: { in: classes.map((c) => c.id) }, status: "ACTIVE" },
        select: { studentId: true },
      })) as Array<{ studentId: string }>;
      studentIds = rows.map((r) => r.studentId);
    }
    if (studentIds !== null && studentIds.length === 0) return [];

    const links = (await tx.parentChild.findMany({
      where: studentIds === null ? {} : { studentId: { in: [...new Set(studentIds)] } },
      select: { parentId: true },
    })) as Array<{ parentId: string }>;
    return [...new Set(links.map((l) => l.parentId))];
  }

  /**
   * Tell the audience a meeting has been called.
   *
   * Runs AFTER the slot is committed and never throws: a notification failure
   * must not lose a meeting that already exists. The slot is the durable record;
   * telling people is best-effort, exactly as the booking notice already is.
   *
   * CHUNKED, and that is the whole point. `enqueueMany` opens ONE transaction and
   * writes a notification, its deliveries and an audit row per recipient — about
   * four statements each. A whole-school meeting at 2,000 guardians would be
   * ~8,000 statements in a single transaction, holding locks and flooding the
   * WAL for as long as it took. In chunks it is a series of short transactions
   * instead, and a chunk that fails costs that chunk rather than the lot.
   */
  private async announce(
    p: Principal,
    slot: { id: string; startsAt: Date; endsAt: Date; location: string | null },
    audience: MeetingAudience,
    label: string,
  ): Promise<void> {
    try {
      const recipients = await this.db.runAsTenantReadOnly(this.ctx(p), (tx) => this.resolveAudience(tx, audience, slot.id));
      if (recipients.length === 0) return;
      const when = slot.startsAt.toISOString().slice(0, 16).replace("T", " ");
      for (let i = 0; i < recipients.length; i += ANNOUNCE_CHUNK) {
        const chunk = recipients.slice(i, i + ANNOUNCE_CHUNK);
        await this.notifications.enqueueMany(this.ctx(p), chunk, {
          type: "GENERIC",
          // A key, not a sentence: enqueueMany renders per RECIPIENT, so a
          // francophone parent is written to in French and an anglophone one in
          // English from the same call.
          key: "meeting.called",
          params: { audience: label, date: when, location: slot.location ?? "the school" },
          title: "A meeting has been called",
          body: `${label} — ${when}${slot.location ? ` at ${slot.location}` : ""}.`,
          data: { slotId: slot.id },
          channels: ["EMAIL"],
        });
      }
      this.logger.log(`Meeting ${slot.id} announced to ${recipients.length} guardian(s): ${label}`);
    } catch (err) {
      // Deliberately swallowed and LOGGED. An announcement that fails silently
      // and invisibly is the worse outcome; the meeting still exists and is on
      // every invited parent's page regardless.
      this.logger.error(`Meeting ${slot.id} announcement failed: ${String(err)}`);
    }
  }

  /**
   * The audiences THIS host may address.
   *
   * Served rather than hard-coded in the UI so the picker can never offer a
   * scope the server would refuse — the authorization rule lives in one place
   * and the screen renders whatever it is given. A teacher gets their own
   * classes; leadership additionally gets the year groups and the school.
   */
  async audienceChoices(p: Principal): Promise<Array<{ kind: string; ref: string | null; label: string }>> {
    const staffWide = p.roles.some((r) => STAFF_WIDE.has(r));
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const classes = staffWide
        ? ((await tx.class.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true }, take: 200 })) as Array<{ id: string; name: string }>)
        : await (async () => {
            const [supervised, taught] = await Promise.all([
              tx.class.findMany({ where: { supervisorId: p.userId }, select: { id: true, name: true } }),
              tx.classSubjectTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } }),
            ]);
            const ids = [...new Set((taught as Array<{ classId: string }>).map((t) => t.classId))];
            const extra = ids.length
              ? ((await tx.class.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as Array<{ id: string; name: string }>)
              : [];
            const seen = new Map<string, string>();
            for (const c of [...(supervised as Array<{ id: string; name: string }>), ...extra]) seen.set(c.id, c.name);
            return [...seen].map(([id, name]) => ({ id, name }));
          })();

      // Which year groups this school actually USES. Offering all four to a
      // primary school invites a meeting with no one in it.
      const stagesInUse = staffWide
        ? [
            ...new Set(
              ((await tx.class.findMany({ select: { stage: true } })) as Array<{ stage: string | null }>)
                .map((c) => c.stage)
                .filter((x): x is string => !!x),
            ),
          ]
        : [];

      // The streams this school actually runs, as (stage, level, stream) triples.
      // Distinct on the DB rather than in JS so it stays one indexed read even
      // when a school has sixty classes.
      const streamsInUse = staffWide
        ? ((await tx.class.findMany({
            where: { stream: { not: null }, stage: { not: null }, level: { not: null } },
            select: { stage: true, level: true, stream: true },
            distinct: ["stage", "level", "stream"],
            orderBy: [{ stage: "asc" }, { level: "asc" }, { stream: "asc" }],
          })) as Array<{ stage: string | null; level: number | null; stream: string | null }>)
        : [];

      return [
        // A 1:1 appointment first: it is the common case and the safest default,
        // which is why it is index 0 in the picker.
        { kind: "STUDENT", ref: null, label: "One pupil (appointment)" },
        ...classes.map((c) => ({ kind: "CLASS", ref: c.id, label: `All ${c.name} parents` })),
        ...streamsInUse.map((s) => ({
          kind: "STREAM",
          ref: streamAudienceRef(s.stage!, s.level!, s.stream!),
          label: `All ${streamLabel(s.stage, s.level, s.stream)} parents`,
        })),
        ...stagesInUse.map((st) => ({ kind: "STAGE", ref: st, label: `All ${STAGE_LABELS[st] ?? st} parents` })),
        ...(staffWide ? [{ kind: "SCHOOL", ref: null, label: "All parents in the school" }] : []),
      ];
    });
  }

  async createSlot(
    p: Principal,
    input: {
      teacherId?: string; startsAt: string; endsAt: string; capacity?: number; location?: string;
      note?: string; provider?: string | null; joinUrl?: string | null;
      /** Who it is for. Omitted = SCHOOL, which is what every slot was before. */
      audience?: MeetingAudience;
      /** For a SELECTED audience: the parents to invite. Ignored otherwise. */
      inviteeIds?: string[];
      /** Colleagues who will also be in the room. The organiser stays teacherId. */
      cohostIds?: string[];
    },
  ): Promise<MeetingSlotDto> {
    const staffWide = p.roles.some((r) => STAFF_WIDE.has(r));
    const teacherId = input.teacherId && staffWide ? input.teacherId : p.userId;
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw new BadRequestException("endsAt must be after startsAt");
    }
    // Validate the optional video link BEFORE opening a transaction: an invalid
    // URL is a client error, not a half-written slot.
    const link = this.validateLink(input.provider, input.joinUrl);

    // An OMITTED audience keeps the old behaviour exactly: an open slot any
    // parent may find and book. That is not the same act as calling a meeting,
    // and conflating the two is what broke the existing tests — a teacher
    // offering availability is not summoning the school.
    const declared = input.audience;
    const audience: MeetingAudience = declared ?? { kind: "SCHOOL", ref: null };
    const audienceProblem = meetingAudienceProblem(audience);
    if (audienceProblem) throw new BadRequestException(audienceProblem);
    // WHO MAY SUMMON WHOM. Choosing to address a year group or the whole school
    // is a leadership act, and one a teacher must not be able to perform by
    // changing a dropdown. It bites on a DECLARED audience only: passing nothing
    // means "I did not choose a scope", never "I chose everyone".
    // A hand-picked set can span the whole school, so it is a leadership act for
    // the same reason a year group is: a teacher must not be able to summon an
    // arbitrary list of families by ticking boxes.
    if (declared && (declared.kind === "STAGE" || declared.kind === "STREAM" || declared.kind === "SCHOOL" || declared.kind === "SELECTED") && !staffWide) {
      throw new ForbiddenException(
        "Only a principal or school administrator can call a meeting for selected parents, a year group or the whole school.",
      );
    }
    const dto = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const { className, studentName } = await this.assertAudienceExists(tx, p, audience, staffWide);
      // A DELEGATED host is checked exactly as a cohost is. Opening a slot for
      // YOURSELF needs none of it: you are signed in, still here, and hold the
      // permission that reached this route.
      if (teacherId !== p.userId) await this.assertMayHost(tx, [teacherId], "host");
      const row = await tx.meetingSlot.create({
        data: {
          schoolId: p.schoolId,
          teacherId,
          startsAt,
          endsAt,
          // A 1:1 appointment is capacity 1; a year-group or school briefing is
          // a room, so the ceiling follows the audience rather than a single
          // number that is wrong for one of them.
          capacity: Math.max(1, Math.min(input.capacity ?? 1, audience.kind === "STUDENT" ? 5 : 2000)),
          audienceKind: audience.kind,
          audienceRef: audience.ref,
          // Only a DECLARED wide audience is a briefing. An omitted audience is
          // a plain bookable slot — an appointment — and must keep its capacity
          // claim, which is what deriving this from `audience` silently lost.
          kind: declared && !isAppointment(declared.kind) ? "BRIEFING" : "APPOINTMENT",
          location: input.location ?? null,
          note: input.note ?? null,
          provider: link.provider,
          joinUrl: link.joinUrl,
        },
      });
      await this.audit.record(
        { actorId: p.userId, action: "meeting.slot.create", entity: "meeting_slot", entityId: row.id, schoolId: p.schoolId, metadata: { teacherId } },
        tx,
      );
      if (audience.kind === "SELECTED") {
        const ids = [...new Set(input.inviteeIds ?? [])].filter(Boolean);
        if (ids.length === 0) throw new BadRequestException("Choose at least one parent to invite.");
        if (ids.length > 500) throw new BadRequestException("Invite at most 500 parents at a time.");
        // Every id must be a real parent IN THIS SCHOOL. RLS already confines the
        // lookup to the tenant, so a foreign id simply is not found — and an
        // invitation to somebody who does not exist is a meeting one fewer
        // person attends, discovered by an empty chair.
        const found = (await tx.parentChild.findMany({
          where: { parentId: { in: ids } },
          select: { parentId: true },
          distinct: ["parentId"],
        })) as Array<{ parentId: string }>;
        const real = new Set(found.map((f) => f.parentId));
        const unknown = ids.filter((i) => !real.has(i));
        if (unknown.length > 0) {
          throw new BadRequestException(`${unknown.length} of those are not parents at this school.`);
        }
        await tx.meetingInvitee.createMany({
          data: ids.map((parentId) => ({ schoolId: p.schoolId, slotId: row.id, parentId })),
          skipDuplicates: true,
        });
      }
      // Colleagues attending alongside the organiser. Checked to be STAFF of
      // this school: RLS confines the lookup to the tenant, and the role check
      // stops a parent being added as a host — which would hand them the join
      // link before the window and the organiser's view of the slot.
      const wantedCohosts = [...new Set(input.cohostIds ?? [])].filter((id) => id && id !== teacherId);
      if (wantedCohosts.length > 0) {
        if (wantedCohosts.length > 20) throw new BadRequestException("A meeting can have at most 20 additional staff.");
        await this.assertMayHost(tx, wantedCohosts, "co-host");
        await tx.meetingCohost.createMany({
          data: wantedCohosts.map((tid) => ({ schoolId: p.schoolId, slotId: row.id, teacherId: tid })),
          skipDuplicates: true,
        });
      }
      return this.toSlotDto(row, 0, teacherId === p.userId ? p : null, undefined, {
        class: audience.kind === "CLASS" ? className : null,
        student: audience.kind === "STUDENT" ? studentName : null,
        stage: audience.kind === "STAGE" ? STAGE_LABELS[audience.ref!] ?? null : null,
        stream: audience.kind === "STREAM" ? streamRefLabel(audience.ref) : null,
      });
    });

    // AFTER the transaction, and only for a DECLARED audience. An open bookable
    // slot invites nobody — parents find it — so announcing one would be sending
    // the whole school a notice about a teacher's free half-hour.
    // Tell the colleagues. Separate from the parent announcement: a co-host is
    // being asked to attend, not invited to book, and the two read differently.
    const cohostIds = [...new Set(input.cohostIds ?? [])].filter((id) => id && id !== teacherId);
    if (cohostIds.length > 0) {
      try {
        await this.notifications.enqueueMany(this.ctx(p), cohostIds, {
          type: "GENERIC",
          key: "meeting.cohost_added",
          params: { date: startsAt.toISOString().slice(0, 16).replace("T", " "), audience: dto.audienceLabel },
          title: "You have been added to a meeting",
          body: `${dto.audienceLabel} — ${startsAt.toISOString().slice(0, 16).replace("T", " ")}.`,
          data: { slotId: dto.id },
          channels: ["EMAIL"],
        });
      } catch (err) {
        this.logger.error(`Meeting ${dto.id} co-host notice failed: ${String(err)}`);
      }
    }

    if (declared && declared.kind !== "STUDENT") {
      await this.announce(p, { id: dto.id, startsAt, endsAt, location: input.location ?? null }, audience, dto.audienceLabel);
    }
    return dto;
  }

  /** Withdraw an unbooked slot. Host / staff-wide. */
  async withdrawSlot(p: Principal, id: string): Promise<{ withdrawn: boolean }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const slot = await tx.meetingSlot.findFirst({ where: { id }, select: { teacherId: true } });
      if (!slot) throw new NotFoundException("Slot not found");
      if (slot.teacherId !== p.userId && !p.roles.some((r) => STAFF_WIDE.has(r))) {
        throw new ForbiddenException("Only the host or an administrator may withdraw this slot");
      }
      const booked = await tx.meetingBooking.count({ where: { slotId: id, status: "BOOKED" } });
      if (booked > 0) throw new ConflictException("The slot has bookings — cancel those first");
      await tx.meetingSlot.update({ where: { id }, data: { active: false } });
      await this.audit.record(
        { actorId: p.userId, action: "meeting.slot.withdraw", entity: "meeting_slot", entityId: id, schoolId: p.schoolId },
        tx,
      );
      return { withdrawn: true };
    });
  }

  /** The caller's own hosted slots (teacher/staff) with booking counts. */
  async mySlots(p: Principal): Promise<MeetingSlotDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const staffWide = p.roles.some((r) => STAFF_WIDE.has(r));
      // A colleague added to a meeting has to be able to SEE it, or being added
      // is an invitation they never receive. One bounded lookup — the meetings
      // this person is attending — then the same single query.
      const attending = staffWide
        ? []
        : ((await tx.meetingCohost.findMany({
            where: { teacherId: p.userId },
            select: { slotId: true },
          })) as Array<{ slotId: string }>);
      const slots = await tx.meetingSlot.findMany({
        where: staffWide
          ? {}
          : attending.length > 0
            ? { OR: [{ teacherId: p.userId }, { id: { in: attending.map((a) => a.slotId) } }] }
            : { teacherId: p.userId },
        orderBy: { startsAt: "asc" },
        take: 200,
      });
      const counts = await this.bookingCounts(tx, slots.map((s: { id: string }) => s.id));
      // Host view only — see bookingsForHost.
      const bookings = await this.bookingsForHost(tx, slots.map((s: { id: string }) => s.id));
      const teacherNames = await this.userNames(tx, slots.map((s: { teacherId: string }) => s.teacherId));
      const namesFor = await this.audienceNamesFor(tx, slots as SlotRow[]);
      const cohosts = await this.cohostsFor(tx, slots as SlotRow[]);
      // A co-host must count as a host for the join link, so their ids ride on
      // the row rather than being looked up again inside toSlotDto.
      return slots.map((s: SlotRow) => ({
        ...this.toSlotDto(
          { ...s, cohostIds: (cohosts.get(s.id) ?? []).map((c) => c.id) },
          counts.get(s.id) ?? 0, p, teacherNames.get(s.teacherId), namesFor(s), cohosts.get(s.id) ?? [],
        ),
        bookings: bookings.get(s.id) ?? [],
      }));
    });
  }

  // --- parent: browse + book --------------------------------------------------

  /** Open slots a parent can book (future, active, not full). Teacher optional. */
  /**
   * The meetings THIS family is invited to.
   *
   * It used to return every open slot in the school, which is why the page read
   * as ambiguous: a parent saw a maths teacher's slots for a class their child
   * is not in, with nothing saying which were meant for them.
   *
   * The filter runs FROM the family OUTWARDS — the caller's children, their
   * classes, those classes' year groups — and asks for slots matching any of
   * those, plus the whole-school ones. That is three small lookups bounded by
   * how many children this parent has, then ONE indexed query.
   *
   * It deliberately never resolves the other direction. "Who is invited to the
   * whole-school meeting" is thousands of guardians, and a page that computed
   * it on every render is the lag this design exists to avoid — nothing fans
   * out until a notification is actually sent.
   */
  async openSlots(p: Principal, teacherId?: string): Promise<MeetingSlotDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const children = (await tx.parentChild.findMany({
        where: { parentId: p.userId },
        select: { studentId: true },
      })) as Array<{ studentId: string }>;
      const studentIds = children.map((c) => c.studentId);
      const enrolments = studentIds.length
        ? ((await tx.enrollment.findMany({
            where: { studentId: { in: studentIds }, status: "ACTIVE" },
            select: { classId: true },
          })) as Array<{ classId: string }>)
        : [];
      const classIds = [...new Set(enrolments.map((e) => e.classId))];
      // One read gives BOTH the year groups and the streams these children are
      // in — still from the family outwards, still bounded by the number of
      // children, never by the size of the school.
      const childClasses = classIds.length
        ? ((await tx.class.findMany({
            where: { id: { in: classIds } },
            select: { stage: true, level: true, stream: true },
          })) as Array<{ stage: string | null; level: number | null; stream: string | null }>)
        : [];
      const stages = childClasses.map((c) => c.stage).filter((x): x is string => !!x);
      const streamRefs = [
        ...new Set(
          childClasses
            .filter((c) => c.stage && c.level != null && c.stream)
            .map((c) => streamAudienceRef(c.stage!, c.level!, c.stream!)),
        ),
      ];

      // SELECTED is matched through the invitee table rather than by rule — the
      // one audience whose membership is stored. Bounded: the ids this parent
      // is on, which is however many meetings they have been invited to.
      const invited = (await tx.meetingInvitee.findMany({
        where: { parentId: p.userId },
        select: { slotId: true },
      })) as Array<{ slotId: string }>;

      const audienceFilter = [
        { audienceKind: "SCHOOL" },
        ...(invited.length ? [{ id: { in: invited.map((i) => i.slotId) } }] : []),
        ...(studentIds.length ? [{ audienceKind: "STUDENT", audienceRef: { in: studentIds } }] : []),
        ...(classIds.length ? [{ audienceKind: "CLASS", audienceRef: { in: classIds } }] : []),
        ...(stages.length ? [{ audienceKind: "STAGE", audienceRef: { in: [...new Set(stages)] } }] : []),
        // Without this a parent is announced to a stream meeting and then
        // cannot find it — the notification arrives, the page stays empty.
        ...(streamRefs.length ? [{ audienceKind: "STREAM", audienceRef: { in: streamRefs } }] : []),
      ];

      // FULL SLOTS ARE DROPPED AFTER THE FETCH — Prisma cannot filter on a
      // relation count, and a slot's bookings are rows rather than a column. So
      // the page is refilled until it holds 200 slots that can actually be
      // booked, instead of 200 candidates of which the bookable ones are
      // whatever survives. Reading the first 200 and then discarding the full
      // ones showed a parent "no times available" while later slots stood open
      // — and the earliest slots are exactly the ones that fill first, so the
      // busier the evening, the more of the list was already gone.
      const PAGE = 200;
      const MAX_PAGES = 5;
      const slots: Array<{ id: string; teacherId: string; capacity: number }> = [];
      const counts = new Map<string, number>();
      for (let page = 0; page < MAX_PAGES && slots.length < PAGE; page++) {
        const batch = (await tx.meetingSlot.findMany({
          where: {
            active: true,
            startsAt: { gte: new Date() },
            ...(teacherId ? { teacherId } : {}),
            OR: audienceFilter,
          },
          orderBy: { startsAt: "asc" },
          take: PAGE,
          skip: page * PAGE,
        })) as Array<{ id: string; teacherId: string; capacity: number }>;
        if (batch.length === 0) break;
        const batchCounts = await this.bookingCounts(tx, batch.map((s) => s.id));
        for (const [id, n] of batchCounts) counts.set(id, n);
        slots.push(...batch.filter((s) => (batchCounts.get(s.id) ?? 0) < s.capacity));
        // A short page means the source is exhausted; there is nothing further
        // back to look at, however few open slots were found.
        if (batch.length < PAGE) break;
      }
      slots.length = Math.min(slots.length, PAGE);
      const teacherNames = await this.userNames(tx, slots.map((s: { teacherId: string }) => s.teacherId));
      const namesFor = await this.audienceNamesFor(tx, slots as SlotRow[]);
      const cohosts = await this.cohostsFor(tx, slots as SlotRow[]);
      // Already filtered to bookable slots above.
      return (slots as SlotRow[]).map((s: SlotRow) =>
        this.toSlotDto(s, counts.get(s.id) ?? 0, null, teacherNames.get(s.teacherId), namesFor(s), cohosts.get(s.id) ?? []),
      );
    });
  }

  /** Book a slot for the parent's child. Atomic capacity claim. */
  async book(p: Principal, slotId: string, studentId: string, note?: string): Promise<MeetingBookingDto> {
    const outcome = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      // The child must be the caller's own.
      const link = await tx.parentChild.findFirst({ where: { parentId: p.userId, studentId }, select: { id: true } });
      if (!link) throw new ForbiddenException("You can only book for your own child");
      const slot = await tx.meetingSlot.findFirst({ where: { id: slotId, active: true }, select: { id: true, teacherId: true, capacity: true, startsAt: true, kind: true } });
      if (!slot) throw new NotFoundException("Slot not found");
      if (slot.startsAt < new Date()) throw new BadRequestException("That slot is in the past");
      // No double-booking the same slot by the same parent.
      const dup = await tx.meetingBooking.findFirst({ where: { slotId, parentId: p.userId, status: "BOOKED" }, select: { id: true } });
      if (dup) throw new ConflictException("You already have a booking for this slot");
      // THE CAPACITY CLAIM RUNS FOR APPOINTMENTS ONLY.
      //
      // An appointment allocates a scarce thing — one teacher, one half-hour —
      // so it must serialise, and counting inside the transaction is the correct
      // way to do that at appointment scale.
      //
      // A BRIEFING allocates nothing. Running this over one would be O(n^2): each
      // of 2,000 parents COUNTs every booking already on the slot, all contending
      // on the same rows. That is exactly how responding to a whole-school notice
      // would take the system down. A hall either fits people or it does not, and
      // that is not a per-parent transaction — so attendance is recorded by the
      // INSERT alone, with the unique index doing the duplicate check.
      if ((slot.kind ?? "APPOINTMENT") === "APPOINTMENT") {
        // Locked for the rest of the transaction so the count and the insert are
        // atomic: an appointment slot holds a handful of places, and two parents
        // pressing Book on the last one both read `booked < capacity` and both
        // get it. Contention is trivial here precisely because the slot is
        // small — which is exactly why the BRIEFING path above skips this, where
        // two thousand parents on one slot would serialise into a queue.
        await tx.$executeRaw`SELECT id FROM "meeting_slot" WHERE id = ${slotId}::uuid FOR UPDATE`;
        const booked = await tx.meetingBooking.count({ where: { slotId, status: "BOOKED" } });
        if (booked >= slot.capacity) throw new ConflictException("That slot is fully booked");
      }
      const row = await tx.meetingBooking.create({
        data: { schoolId: p.schoolId, slotId, parentId: p.userId, studentId, note: note ?? null },
      });
      await this.audit.record(
        { actorId: p.userId, action: "meeting.book", entity: "meeting_booking", entityId: row.id, schoolId: p.schoolId, metadata: { slotId, studentId } },
        tx,
      );
      const student = await tx.user.findFirst({ where: { id: studentId }, select: { name: true } });
      return { row, teacherId: slot.teacherId, startsAt: slot.startsAt, studentName: student?.name ?? "" };
    });

    try {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: outcome.teacherId,
        type: "GENERIC",
        title: "Parent meeting booked",
        body: `A parent booked a meeting about ${outcome.studentName} for ${outcome.startsAt.toISOString().slice(0, 16).replace("T", " ")}.`,
        data: { slotId, bookingId: outcome.row.id },
        channels: ["EMAIL"],
      });
    } catch {
      /* non-fatal */
    }
    return this.toBookingDto(outcome.row, outcome.startsAt, outcome.studentName);
  }

  /** Cancel a booking. The booking parent, the host teacher, or staff-wide. */
  async cancelBooking(p: Principal, bookingId: string): Promise<{ cancelled: boolean }> {
    const outcome = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const b = await tx.meetingBooking.findFirst({ where: { id: bookingId }, include: { slot: { select: { teacherId: true, startsAt: true } } } });
      if (!b) throw new NotFoundException("Booking not found");
      const staffWide = p.roles.some((r) => STAFF_WIDE.has(r));
      if (b.parentId !== p.userId && b.slot.teacherId !== p.userId && !staffWide) {
        throw new ForbiddenException("You cannot cancel this booking");
      }
      if (b.status !== "BOOKED") throw new BadRequestException("Already cancelled");
      await tx.meetingBooking.update({ where: { id: bookingId }, data: { status: "CANCELLED" } });
      await this.audit.record(
        { actorId: p.userId, action: "meeting.cancel", entity: "meeting_booking", entityId: bookingId, schoolId: p.schoolId },
        tx,
      );
      // Notify the OTHER party.
      const notifyId = p.userId === b.parentId ? b.slot.teacherId : b.parentId;
      return { notifyId, startsAt: b.slot.startsAt };
    });
    try {
      await this.notifications.enqueue(this.ctx(p), {
        recipientId: outcome.notifyId,
        type: "GENERIC",
        title: "Parent meeting cancelled",
        body: `A meeting scheduled for ${outcome.startsAt.toISOString().slice(0, 16).replace("T", " ")} was cancelled.`,
        data: { bookingId },
        channels: ["EMAIL"],
      });
    } catch {
      /* non-fatal */
    }
    return { cancelled: true };
  }

  /** A parent's own bookings (BOOKED, future first). */
  async myBookings(p: Principal): Promise<MeetingBookingDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = await tx.meetingBooking.findMany({
        where: { parentId: p.userId, status: "BOOKED" },
        include: { slot: { select: { startsAt: true, teacherId: true, location: true } } },
        orderBy: { slot: { startsAt: "asc" } },
        take: 100,
      });
      type Row = BookingRow & { slot: { startsAt: Date; teacherId: string; location: string | null } };
      const withSlot = rows as Row[];
      const studentNames = await this.userNames(tx, withSlot.map((r) => r.studentId));
      const teacherNames = await this.userNames(tx, withSlot.map((r) => r.slot.teacherId));
      return withSlot.map((r) =>
        this.toBookingDto(r, r.slot.startsAt, studentNames.get(r.studentId) ?? "", teacherNames.get(r.slot.teacherId), r.slot.location),
      );
    });
  }

  // --- helpers ----------------------------------------------------------------

  /**
   * The bookings on a host's own slots, with names.
   *
   * ONLY ever called from `mySlots`. A host needs this twice over: to know which
   * family is coming, and — since a cancellation needs a booking id — to be able
   * to release a slot at all. It must never reach `openSlots`, where one parent
   * would learn which other families had booked.
   */
  /**
   * WHO MAY BE PUT IN FRONT OF A FAMILY AS A HOST.
   *
   * The cohost path asked three careful questions — is this a staff member of
   * this school, can they actually open the meetings page, and are there fewer
   * than twenty — while the HOST, the person a parent books a meeting WITH, was
   * validated in no way at all. `teacherId` is taken from any staff-wide caller,
   * so a principal could open a bookable slot hosted by a PARENT (the exact harm
   * the cohost comment describes: it hands them the join link before the window
   * and the organiser's view of the slot) or by a uuid that is nobody, which
   * renders with no name and can still be booked. Measured live: both 201.
   *
   * ONE rule for both rather than two spellings of it — the host and the cohosts
   * stand in the same relation to the family, and a pair of checks that ought to
   * agree is how this diverged in the first place.
   */
  private async assertMayHost(tx: TenantTx, ids: string[], noun: string): Promise<void> {
    if (ids.length === 0) return;
    // STILL EMPLOYED. A meeting is FUTURE work: naming somebody who has left
    // sends an invitation into an inbox its owner can no longer open and tells
    // the organiser they are attending — the rule `assertStillHere` already
    // applies to a cover reliever and an invigilator. Meetings were never on
    // that list. Batched rather than per-id: a slot may carry twenty cohosts.
    const people = (await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, status: true },
    })) as Array<{ id: string; name: string; status: string }>;
    const byId = new Map(people.map((u) => [u.id, u]));
    // RLS confines the lookup to the tenant, so a foreign id is simply absent
    // and this can never confirm that another school's user exists.
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`${missing.length} of those are not staff at this school.`);
    }
    const gone = ids.filter((id) => byId.get(id)!.status !== STILL_HERE.status);
    if (gone.length > 0) {
      throw new BadRequestException(
        `${gone.map((id) => byId.get(id)!.name).join(", ")} has left the school and cannot ${noun} a meeting.`,
      );
    }
    const staff = (await tx.userRole.findMany({
      where: { userId: { in: ids }, role: { name: { notIn: [...NON_STAFF_ROLE_NAMES] } } },
      select: { userId: true },
      distinct: ["userId"],
    })) as Array<{ userId: string }>;
    const ok = new Set(staff.map((x) => x.userId));
    const notStaff = ids.filter((id) => !ok.has(id));
    if (notStaff.length > 0) {
      throw new BadRequestException(`${notStaff.length} of those are not staff at this school.`);
    }
    // AND they must be able to SEE a meeting. Being staff is not enough: the
    // meetings list is gated on `meeting.host`, so somebody without it would be
    // named on the slot and then get a 403 — an invitation that never arrives,
    // and invisible to whoever sent it.
    const canSee = (await tx.userRole.findMany({
      where: {
        userId: { in: ids },
        role: { permissions: { some: { permission: { key: MEETING_PERMISSIONS.MEETING_HOST } } } },
      },
      select: { userId: true },
      distinct: ["userId"],
    })) as Array<{ userId: string }>;
    const seeing = new Set(canSee.map((x) => x.userId));
    const blind = ids.filter((id) => !seeing.has(id));
    if (blind.length > 0) {
      throw new BadRequestException(
        `${blind.length} of those cannot open the meetings page, so they would never see this. Their role needs meeting access first.`,
      );
    }
  }

  private async bookingsForHost(
    tx: TenantTx,
    slotIds: string[],
  ): Promise<Map<string, Array<{ id: string; parentName: string | null; studentName: string | null }>>> {
    const out = new Map<string, Array<{ id: string; parentName: string | null; studentName: string | null }>>();
    if (slotIds.length === 0) return out;
    const rows = (await tx.meetingBooking.findMany({
      where: { slotId: { in: slotIds }, status: "BOOKED" },
      select: { id: true, slotId: true, parentId: true, studentId: true },
      take: 2000,
    })) as Array<{ id: string; slotId: string; parentId: string; studentId: string }>;
    if (rows.length === 0) return out;
    const names = await this.userNames(tx, [...rows.map((r) => r.parentId), ...rows.map((r) => r.studentId)]);
    for (const r of rows) {
      const list = out.get(r.slotId) ?? [];
      list.push({
        id: r.id,
        parentName: names.get(r.parentId) ?? null,
        studentName: names.get(r.studentId) ?? null,
      });
      out.set(r.slotId, list);
    }
    return out;
  }

  private async bookingCounts(tx: TenantTx, slotIds: string[]): Promise<Map<string, number>> {
    if (slotIds.length === 0) return new Map();
    const grouped = await tx.meetingBooking.groupBy({ by: ["slotId"], where: { slotId: { in: slotIds }, status: "BOOKED" }, _count: { _all: true } });
    return new Map(grouped.map((g: { slotId: string; _count: { _all: number } }) => [g.slotId, g._count._all]));
  }

  private async userNames(tx: TenantTx, ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (uniq.length === 0) return new Map();
    const users = await tx.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map<string, string>(users.map((u: { id: string; name: string }) => [u.id, u.name] as const));
  }

  /**
   * Validate an optional video link. A provider MUST be one we know, and the URL
   * must survive the shared validator (https + per-provider host allowlist), so a
   * "Teams" meeting can never be stored pointing somewhere else. Supplying one
   * without the other is a client error rather than a silent half-configured slot.
   */
  private validateLink(provider?: string | null, joinUrl?: string | null): { provider: string | null; joinUrl: string | null } {
    const hasP = !!provider && provider.trim() !== "";
    const hasU = !!joinUrl && joinUrl.trim() !== "";
    if (!hasP && !hasU) return { provider: null, joinUrl: null };
    if (hasP !== hasU) throw new BadRequestException("A video meeting needs both a provider and a join link");
    if (!(MEETING_PROVIDERS as readonly string[]).includes(provider as string)) {
      throw new BadRequestException("Unknown meeting provider");
    }
    const url = normalizeMeetingUrl(provider as MeetingProvider, joinUrl as string);
    if (!url) throw new BadRequestException(`That is not a valid https ${provider} meeting link`);
    return { provider: provider as string, joinUrl: url };
  }

  /**
   * Names for the audience labels of a page of slots.
   *
   * Two bounded lookups keyed on the DISTINCT refs actually present — not one
   * per slot, and never a resolution of who is in the audience. A stage needs no
   * lookup at all; it is a static label.
   */
  /** Co-hosts for a page of slots: ONE query over the slot ids, then grouped —
   *  not a lookup per row. */
  private async cohostsFor(tx: TenantTx, slots: SlotRow[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const ids = slots.map((s) => s.id);
    const out = new Map<string, Array<{ id: string; name: string }>>();
    if (ids.length === 0) return out;
    const rows = (await tx.meetingCohost.findMany({
      where: { slotId: { in: ids } },
      select: { slotId: true, teacherId: true },
    })) as Array<{ slotId: string; teacherId: string }>;
    if (rows.length === 0) return out;
    const names = await this.userNames(tx, rows.map((r) => r.teacherId));
    for (const r of rows) {
      const arr = out.get(r.slotId) ?? [];
      arr.push({ id: r.teacherId, name: names.get(r.teacherId) ?? "Staff" });
      out.set(r.slotId, arr);
    }
    return out;
  }

  private async audienceNamesFor(tx: TenantTx, slots: SlotRow[]) {
    const classIds = [...new Set(slots.filter((s) => s.audienceKind === "CLASS" && s.audienceRef).map((s) => s.audienceRef!))];
    const studentIds = [...new Set(slots.filter((s) => s.audienceKind === "STUDENT" && s.audienceRef).map((s) => s.audienceRef!))];
    const [classes, students] = await Promise.all([
      classIds.length
        ? (tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }) as Promise<Array<{ id: string; name: string }>>)
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      studentIds.length
        ? (tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true } }) as Promise<Array<{ id: string; name: string }>>)
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);
    const classBy = new Map(classes.map((c) => [c.id, c.name]));
    const studentBy = new Map(students.map((u) => [u.id, u.name]));
    return (s: SlotRow) => ({
      class: s.audienceRef ? classBy.get(s.audienceRef) ?? null : null,
      student: s.audienceRef ? studentBy.get(s.audienceRef) ?? null : null,
      stage: s.audienceRef ? STAGE_LABELS[s.audienceRef] ?? null : null,
      stream: s.audienceKind === "STREAM" ? streamRefLabel(s.audienceRef) : null,
    });
  }

  private toSlotDto(
    s: SlotRow,
    booked: number,
    p: Principal | null,
    teacherName?: string,
    /** Names for the audience label. Absent = a generic label, never a wrong one. */
    audienceNames?: { student?: string | null; class?: string | null; stage?: string | null; stream?: string | null },
    cohosts?: Array<{ id: string; name: string }>,
  ): MeetingSlotDto {
    // SECURITY: the join link is released only inside the server-computed window
    // (15 min before -> 30 min after), so a link that leaks early is unusable.
    // The HOST always sees their own link — they created it and need it to hand
    // out or re-open.
    // A co-host is in the room, so they get the link on the same terms as the
    // organiser. Without this they would be told to attend and then be unable to.
    const isHost = !!p && (p.userId === s.teacherId || (s.cohostIds ?? []).includes(p.userId));
    const open = isMeetingJoinOpen(s.startsAt, s.endsAt);
    return {
      id: s.id,
      teacherId: s.teacherId,
      teacherName: teacherName ?? null,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      capacity: s.capacity,
      booked,
      location: s.location,
      note: s.note,
      active: s.active,
      kind: s.kind ?? "APPOINTMENT",
      cohosts: cohosts ?? [],
      audienceKind: s.audienceKind ?? "SCHOOL",
      audienceRef: s.audienceRef ?? null,
      // Built here, once, rather than in each of the three screens that show a
      // slot — otherwise "All JSS2 parents" is worded three different ways.
      audienceLabel: describeAudience(
        { kind: (s.audienceKind ?? "SCHOOL") as MeetingAudienceKind, ref: s.audienceRef ?? null },
        audienceNames ?? {},
      ),
      provider: s.provider ?? null,
      /** Null until the window opens (or unless you are the host). */
      joinUrl: s.joinUrl ? (open || isHost ? s.joinUrl : null) : null,
      joinOpen: !!s.joinUrl && open,
      joinOpensAt: s.joinUrl ? meetingJoinOpensAt(s.startsAt) : null,
    };
  }

  private toBookingDto(b: BookingRow, startsAt: Date, studentName: string, teacherName?: string, location?: string | null): MeetingBookingDto {
    return {
      id: b.id,
      slotId: b.slotId,
      studentId: b.studentId,
      studentName,
      teacherName: teacherName ?? null,
      startsAt,
      location: location ?? null,
      status: b.status,
      note: b.note,
    };
  }
}

type SlotRow = { id: string; teacherId: string; startsAt: Date; endsAt: Date; capacity: number; location: string | null; note: string | null; active: boolean; provider: string | null; joinUrl: string | null; audienceKind?: string | null; audienceRef?: string | null; kind?: string | null; cohostIds?: string[] };
type BookingRow = { id: string; slotId: string; studentId: string; status: string; note: string | null; slot?: { startsAt: Date; teacherId: string; location: string | null } };
