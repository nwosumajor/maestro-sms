// =============================================================================
// LmsService — classes, enrollment, and RELATIONSHIP SCOPING
// =============================================================================
// Security spine of the LMS. Coarse permissions gate the endpoints; this service
// narrows the ROWS by relationship (RBAC model, CLAUDE.md):
//   - teacher  -> classes they teach        (class_teacher)
//   - student  -> classes they're enrolled  (enrollment)
//   - parent   -> classes their children    (parent_child -> enrollment)
//   - school_admin / super_admin -> all classes in their tenant
// Everything runs inside a tenant transaction (RLS-enforced) and mutations are
// audit-logged. Not-visible -> 404 (never 403), no cross-tenant/owner leak.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { SchoolRegionService } from "../foundation/school-region.service";
// VALUE import: Prisma.sql/join only resolve as values, not types (CLAUDE.md).
import { Prisma } from "@sms/db";
import { ON_ROLL_STUDENT } from "../common/student-scope";
import {
  NON_STAFF_ROLE_NAMES,
  MAX_GUARDIANS_PER_STUDENT,
  ROSTER_CAP,
  SEARCH_CAP,
  DEFAULT_CURRICULUM,
  normaliseEntityCode,
  subjectCatalogueFor,
  uniqueEntityCode,
  type ClassOverviewDto,
  type SubjectStage,
  type UserKind,
  MEETING_PERMISSIONS,
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

// Staff whose duties span the whole school: they may view ANY class roster, the
// full class list, AND the school-wide student directory (req: principal, school
// admin and HR view all students). One set for all whole-school READS — the
// student picker previously used a narrower {school_admin, super_admin} set,
// which left a PRINCIPAL's /students page empty (they fell to the
// relationship path: classes-they-teach + their-children = none).
//
// junior_admin is the operational records tier (CLAUDE.md) and holds class.read,
// class.write, enrollment.read/write, guardian.write, student.import and
// parent.import. Without it here every one of those was a DEAD GRANT: the guard
// let the call through and the row filter returned nothing, so /students,
// /classes and every student picker rendered empty for the tier whose whole job
// is records. SIS, Documents, Attendance, Timetable, Analytics and Search had
// already been widened for it one at a time; this set and Fees were the two
// that were missed. READS only — every write is separately permission-gated,
// so this grants no authority junior_admin did not already hold.
//
// board and head_teacher held class.read and were served zero classes for the
// same reason — no teaching or parental relationship to fall back on. Being in
// this set does NOT give them the same reach, because the controller draws the
// finer line by permission and their grants differ:
//   class.read      -> class list / overview / info   board YES, head_teacher YES
//   enrollment.read -> the ROSTER of pupil names,
//                      roster.csv, eligibility        board NO,  head_teacher YES
// So oversight (board) sees the school's SHAPE — which classes exist, who
// teaches them, how full they are — and the head of teaching, who already holds
// enrollment.read, sees who is in them. Minors' names are gated by the grant,
// not by this set (GR#5), and the roster read stays audit-logged either way.
const ROSTER_WIDE_ROLES = new Set([
  "school_admin",
  "principal",
  "hr_manager",
  "hr_clerk",
  "junior_admin",
  "board",
  "head_teacher",
]);

@Injectable()
export class LmsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    // Optional so existing unit wirings keep working; absent, the catalogue
    // falls back to the general international list rather than failing.
    @Optional() private readonly regions?: SchoolRegionService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isRosterWide(p: Principal): boolean {
    return p.roles.some((r) => ROSTER_WIDE_ROLES.has(r));
  }

  // --- mutations (school_admin) ---------------------------------------------
  /**
   * Resolve the stable per-school `code` for a subject or class. An
   * operator-supplied code wins (normalised); otherwise it is derived from the
   * name by the SAME rule the backfill migration used, de-duplicated against the
   * codes already in this school. A code is what imports, rosters and pickers
   * should key on — names are free text and drift.
   */
  private async nextCode(
    tx: TenantTx,
    entity: "subject" | "class",
    name: string,
    supplied?: string | null,
  ): Promise<string> {
    const rows =
      entity === "subject"
        ? await tx.subject.findMany({ select: { code: true } })
        : await tx.class.findMany({ select: { code: true } });
    const taken = rows.map((r: { code: string }) => r.code).filter(Boolean);
    if (supplied && supplied.trim()) {
      const wanted = normaliseEntityCode(supplied);
      if (!wanted) throw new BadRequestException("Code must contain letters or digits");
      if (taken.some((c) => c.toUpperCase() === wanted)) {
        throw new ConflictException(`Code ${wanted} is already used by another ${entity}`);
      }
      return wanted;
    }
    const derived = uniqueEntityCode(name, taken);
    // A name with no alphanumerics still needs a stable code.
    return derived || `${entity === "subject" ? "SUBJ" : "CLS"}${Date.now() % 1000000}`;
  }

  async createClass(
    p: Principal,
    input: {
      name: string;
      level?: number | null;
      nextClassId?: string | null;
      code?: string | null;
      stage?: string | null;
      stream?: string | null;
      arm?: string | null;
    },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Same catalog rule as subjects: one "JSS2A" per school, or every roster
      // picker fills with twins and enrollments split between them.
      const dup = await tx.class.findFirst({
        where: { name: { equals: input.name, mode: "insensitive" } },
        select: { id: true },
      });
      if (dup) throw new ConflictException("A class with that name already exists");
      const code = await this.nextCode(tx, "class", input.name, input.code);
      const cls = await tx.class.create({
        data: {
          schoolId: p.schoolId,
          name: input.name,
          code,
          level: input.level ?? null,
          nextClassId: input.nextClassId ?? null,
          stage: input.stage ?? null,
          stream: input.stream ?? null,
          arm: input.arm ?? null,
        },
      });
      await this.log(tx, p, "lms.class.create", "class", cls.id, {
        stage: input.stage ?? null,
        stream: input.stream ?? null,
        arm: input.arm ?? null,
      });
      return cls;
    });
  }

  /** Update class progression / supervisor / metadata (school_admin). */
  async updateClass(
    p: Principal,
    classId: string,
    input: {
      name?: string;
      level?: number | null;
      nextClassId?: string | null;
      supervisorId?: string | null;
      capacity?: number | null;
      stage?: string | null;
      stream?: string | null;
      arm?: string | null;
    },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      // A class cannot promote into itself.
      if (input.nextClassId && input.nextClassId === classId) {
        throw new NotFoundException("A class cannot point to itself");
      }
      // Validate referenced rows are in-tenant (RLS scopes these lookups).
      if (input.nextClassId) await this.requireClass(tx, input.nextClassId);
      if (input.supervisorId) {
        const u = await tx.user.findFirst({ where: { id: input.supervisorId }, select: { id: true } });
        if (!u) throw new NotFoundException("Supervisor not found");
      }
      const cls = await tx.class.update({
        where: { id: classId },
        data: {
          name: input.name ?? undefined,
          level: input.level === undefined ? undefined : input.level,
          nextClassId: input.nextClassId === undefined ? undefined : input.nextClassId,
          supervisorId: input.supervisorId === undefined ? undefined : input.supervisorId,
          capacity: input.capacity === undefined ? undefined : input.capacity,
          stage: input.stage === undefined ? undefined : input.stage,
          stream: input.stream === undefined ? undefined : input.stream,
          arm: input.arm === undefined ? undefined : input.arm,
        },
      });
      await this.log(tx, p, "lms.class.update", "class", classId, {
        supervisorId: input.supervisorId,
        level: input.level,
        nextClassId: input.nextClassId,
        capacity: input.capacity,
        stage: input.stage,
        stream: input.stream,
        arm: input.arm,
      });
      return cls;
    });
  }

  /**
   * Delete a class — allowed ONLY while it is EMPTY (a freshly-created duplicate).
   * Refuses (409) if anything references it, so a class holding real records (roster,
   * timetable, attendance, grades, progression) is never silently orphaned; the
   * principal renames it or clears its data first. Audited.
   */
  async deleteClass(p: Principal, classId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true, name: true } });
      if (!cls) throw new NotFoundException("Class not found");
      const [enroll, teachers, subjects, assessments, attendance, content, timetable, games, nextRefs, promoSrc, promoTgt] =
        await Promise.all([
          tx.enrollment.count({ where: { classId } }),
          tx.classTeacher.count({ where: { classId } }),
          tx.classSubjectTeacher.count({ where: { classId } }),
          tx.assessment.count({ where: { classId } }),
          tx.attendanceSession.count({ where: { classId } }),
          tx.lmsContent.count({ where: { classId } }),
          tx.timetableEntry.count({ where: { classId } }),
          tx.game.count({ where: { classId } }),
          tx.class.count({ where: { nextClassId: classId } }),
          tx.promotionBatch.count({ where: { sourceClassId: classId } }),
          tx.promotionBatch.count({ where: { targetClassId: classId } }),
        ]);
      const refs = enroll + teachers + subjects + assessments + attendance + content + timetable + games + nextRefs + promoSrc + promoTgt;
      if (refs > 0) {
        throw new ConflictException(
          "This class still has data (students, teachers, subjects, timetable, attendance, assessments, games, or it's referenced by a promotion/progression). Remove those or rename the class instead of deleting it.",
        );
      }
      await tx.class.delete({ where: { id: classId } });
      await this.log(tx, p, "lms.class.delete", "class", classId, { name: cls.name });
      return { id: classId, deleted: true };
    });
  }

  // --- subject catalog + per-class offerings (subject.manage) ----------------
  /**
   * The catalogue this school should be offered, with what it already has marked.
   *
   * The list follows the school's COUNTRY, the same posture as calendar
   * templates and payroll packs — offering "English Language" to a school in
   * Dakar is worse than offering nothing, because people accept defaults.
   *
   * `added` is resolved by CONCEPT, not by name: a school that picked MTH and
   * then renamed its copy to "Core Mathematics" must not be offered MTH again.
   */
  async subjectCatalogue(p: Principal, stage?: string) {
    const region = await this.regions?.forSchool(p.schoolId);
    const entries = subjectCatalogueFor(region?.country, stage as SubjectStage | undefined);
    const mine = (await this.db.runAsTenantReadOnly(this.ctx(p), (tx) =>
      tx.subject.findMany({ select: { catalogueCode: true } }),
    )) as Array<{ catalogueCode: string | null }>;
    const have = new Set(mine.map((m) => m.catalogueCode).filter(Boolean) as string[]);
    return {
      curriculum: entries[0]?.curriculum ?? DEFAULT_CURRICULUM,
      country: region?.country ?? null,
      subjects: entries.map((e) => ({
        code: e.code,
        name: e.displayName,
        group: e.group,
        stages: e.stages,
        added: have.has(e.code),
      })),
    };
  }

  /**
   * Add picked catalogue entries as this school's OWN subjects.
   *
   * Each becomes a tenant-scoped row with its own uuid — a copy, never a
   * reference. `catalogueCode` is the only link back, which is what keeps the
   * rename safe and RLS intact.
   *
   * Idempotent and partial-tolerant: an entry the school already has (by concept
   * OR by name) is SKIPPED rather than failing the batch. Someone ticking twelve
   * boxes, one of which duplicates a subject they typed by hand last term, should
   * get the other eleven and a plain account of what was skipped — not an error
   * and nothing added.
   */
  async addSubjectsFromCatalogue(p: Principal, codes: string[]) {
    const region = await this.regions?.forSchool(p.schoolId);
    const available = subjectCatalogueFor(region?.country);
    const wanted = [...new Set(codes)];
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const existing = (await tx.subject.findMany({
        select: { name: true, catalogueCode: true },
      })) as Array<{ name: string; catalogueCode: string | null }>;
      const haveCode = new Set(existing.map((e) => e.catalogueCode).filter(Boolean) as string[]);
      const haveName = new Set(existing.map((e) => e.name.trim().toLowerCase()));

      const added: Array<{ id: string; name: string; code: string; catalogueCode: string }> = [];
      const skipped: Array<{ code: string; reason: string }> = [];
      for (const code of wanted) {
        const entry = available.find((a) => a.code === code);
        if (!entry) {
          // Not in THIS school's curriculum — refusing beats silently adding a
          // subject from someone else's list.
          skipped.push({ code, reason: "not in this school's catalogue" });
          continue;
        }
        if (haveCode.has(code)) {
          skipped.push({ code, reason: "already added" });
          continue;
        }
        if (haveName.has(entry.displayName.trim().toLowerCase())) {
          skipped.push({ code, reason: `a subject named "${entry.displayName}" already exists` });
          continue;
        }
        const subjectCode = await this.nextCode(tx, "subject", entry.displayName, null);
        const row = await tx.subject.create({
          data: { schoolId: p.schoolId, name: entry.displayName, code: subjectCode, catalogueCode: code },
        });
        added.push({ id: row.id, name: row.name, code: row.code, catalogueCode: code });
        haveCode.add(code);
        haveName.add(entry.displayName.trim().toLowerCase());
      }
      if (added.length > 0) {
        await this.log(tx, p, "lms.subject.catalogue_add", "subject", added[0].id, {
          added: added.length,
          skipped: skipped.length,
          codes: added.map((a) => a.catalogueCode),
        });
      }
      return { added, skipped };
    });
  }

  async createSubject(p: Principal, input: { name: string; code?: string | null }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // Duplicate guard: subject names are a catalog — one "Mathematics" per
      // school (case-insensitive), or the class-offering pickers fill with twins.
      const dup = await tx.subject.findFirst({
        where: { name: { equals: input.name, mode: "insensitive" } },
        select: { id: true },
      });
      if (dup) throw new ConflictException("A subject with that name already exists");
      const code = await this.nextCode(tx, "subject", input.name, input.code);
      const subj = await tx.subject.create({
        data: { schoolId: p.schoolId, name: input.name, code },
      });
      await this.log(tx, p, "lms.subject.create", "subject", subj.id, { name: input.name });
      return { id: subj.id, name: subj.name, code: subj.code };
    });
  }

  async listSubjects(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const rows = await tx.subject.findMany({ orderBy: { name: "asc" } });
      return rows.map((s) => ({ id: s.id, name: s.name, code: s.code }));
    });
  }

  /** Rename / re-code a subject (the fix-a-typo path; offerings keep pointing
   *  at the same subject id, so nothing else moves). */
  async updateSubject(p: Principal, subjectId: string, input: { name?: string; code?: string | null }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const subj = await tx.subject.findFirst({ where: { id: subjectId } });
      if (!subj) throw new NotFoundException("Subject not found");
      if (input.name) {
        const dup = await tx.subject.findFirst({
          where: { name: { equals: input.name, mode: "insensitive" }, id: { not: subjectId } },
          select: { id: true },
        });
        if (dup) throw new ConflictException("A subject with that name already exists");
      }
      // A code is now the subject's stable key, so it can be CHANGED but never
      // cleared — blanking it would break every import/picker keyed on it.
      let code: string | undefined;
      if (input.code !== undefined && input.code !== null && input.code.trim()) {
        code = normaliseEntityCode(input.code);
        if (!code) throw new BadRequestException("Code must contain letters or digits");
        const clash = await tx.subject.findFirst({
          where: { code: { equals: code, mode: "insensitive" }, id: { not: subjectId } },
          select: { id: true },
        });
        if (clash) throw new ConflictException(`Code ${code} is already used by another subject`);
      }
      const updated = await tx.subject.update({
        where: { id: subjectId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(code ? { code } : {}),
        },
      });
      await this.log(tx, p, "lms.subject.update", "subject", subjectId, {
        from: subj.name,
        to: updated.name,
      });
      return { id: updated.id, name: updated.name, code: updated.code };
    });
  }

  /** Delete an UNUSED subject (duplicate cleanup). Refuses (409) while any class
   *  still offers it — reassign/remove those offerings first, so a slip of the
   *  finger can never orphan class-subject-teacher rows. */
  async deleteSubject(p: Principal, subjectId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const subj = await tx.subject.findFirst({ where: { id: subjectId } });
      if (!subj) throw new NotFoundException("Subject not found");
      const offerings = await tx.classSubjectTeacher.count({ where: { subjectId } });
      if (offerings > 0) {
        throw new ConflictException(
          `"${subj.name}" is offered in ${offerings} class${offerings === 1 ? "" : "es"} — remove or reassign those offerings first`,
        );
      }
      await tx.subject.delete({ where: { id: subjectId } });
      await this.log(tx, p, "lms.subject.delete", "subject", subjectId, { name: subj.name });
      return { ok: true };
    });
  }

  /**
   * Assign (or RE-assign) a teacher to a class's subject offering.
   *
   * One teacher per (class, subject) — a school with several Physics teachers
   * gives them different classes or arms, which is how timetabling works
   * anyway: two people cannot hold the same lesson.
   *
   * Two things this used to do silently, and no longer does:
   *
   * 1. REPLACING somebody looked identical to a first assignment — same 201,
   *    same "Assigned." The previous teacher simply vanished from the offering
   *    and nobody was told. It now reports whom it replaced.
   *
   * 2. The PLACED TIMETABLE did not follow. `timetable_entry.teacherId` is its
   *    own column, so after a reassignment the roster said one teacher and the
   *    week said another — the old teacher kept the lessons in their list and
   *    the new one never saw them. Rewriting a published timetable
   *    automatically would be worse (a cover arrangement is a legitimate
   *    reason for them to differ), so the count is REPORTED and the move is
   *    opt-in.
   */
  async assignClassSubject(
    p: Principal,
    classId: string,
    subjectId: string,
    teacherId: string,
    opts?: { lessonsPerWeek?: number; preferredRoomId?: string | null; moveScheduledLessons?: boolean },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      const subj = await tx.subject.findFirst({ where: { id: subjectId }, select: { id: true } });
      if (!subj) throw new NotFoundException("Subject not found");
      const teacher = await tx.user.findFirst({ where: { id: teacherId }, select: { id: true } });
      if (!teacher) throw new NotFoundException("Teacher not found");

      // Who is being replaced, if anyone — read BEFORE the upsert overwrites it.
      const prev = (await tx.classSubjectTeacher.findFirst({
        where: { classId, subjectId },
        select: { teacherId: true },
      })) as { teacherId: string } | null;
      const replacedId = prev && prev.teacherId !== teacherId ? prev.teacherId : null;
      const replacedName = replacedId
        ? ((await tx.user.findFirst({ where: { id: replacedId }, select: { name: true } })) as { name: string } | null)?.name ?? null
        : null;
      if (opts?.preferredRoomId) {
        const room = await tx.room.findFirst({ where: { id: opts.preferredRoomId }, select: { id: true } });
        if (!room) throw new NotFoundException("Room not found");
      }
      const row = await tx.classSubjectTeacher.upsert({
        where: { classId_subjectId: { classId, subjectId } },
        update: {
          teacherId,
          lessonsPerWeek: opts?.lessonsPerWeek,
          preferredRoomId: opts?.preferredRoomId === undefined ? undefined : opts.preferredRoomId,
        },
        create: {
          schoolId: p.schoolId,
          classId,
          subjectId,
          teacherId,
          lessonsPerWeek: opts?.lessonsPerWeek,
          preferredRoomId: opts?.preferredRoomId ?? null,
        },
      });
      // Placed lessons for this offering that name ANYONE other than the
      // teacher who now holds it.
      //
      // Defined against the NEW teacher, not against whoever was replaced. My
      // first version only looked for the previous holder's lessons, so
      // replacing without moving left them naming a third party that no later
      // call could find — the divergence became permanent the moment you
      // declined to fix it. This way, re-running the assignment with the box
      // ticked repairs it at any time.
      const stale = (await tx.timetableEntry.findMany({
        where: { classId, subjectId, teacherId: { not: teacherId } },
        select: { id: true, dayOfWeek: true, periodId: true },
      })) as Array<{ id: string; dayOfWeek: string; periodId: string }>;

      let moved = 0;
      if (stale.length > 0 && opts?.moveScheduledLessons) {
        // The new teacher may already be teaching in one of those slots. Moving
        // into it would violate the double-booking constraint, so check FIRST
        // and refuse the whole change with something the admin can act on —
        // half-moving a timetable is worse than not moving it.
        const clashes = (await tx.timetableEntry.findMany({
          where: {
            teacherId,
            OR: stale.map((e) => ({ dayOfWeek: e.dayOfWeek as never, periodId: e.periodId })),
          },
          select: { id: true },
        })) as Array<{ id: string }>;
        if (clashes.length > 0) {
          throw new ConflictException(
            `That teacher is already booked in ${clashes.length} of those ${stale.length} slots. Move or clear those lessons first.`,
          );
        }
        const res = await tx.timetableEntry.updateMany({
          where: { id: { in: stale.map((e) => e.id) } },
          data: { teacherId },
        });
        moved = res.count;
      }

      await this.log(tx, p, "lms.class.subject.assign", "class", classId, {
        replacedTeacherId: replacedId,
        scheduledLessons: stale.length,
        movedLessons: moved,
        subjectId,
        teacherId,
        lessonsPerWeek: row.lessonsPerWeek,
        preferredRoomId: row.preferredRoomId,
      });
      // The caller needs to KNOW it replaced somebody and that lessons may now
      // name the wrong teacher — a bare row looks identical either way.
      return {
        ...row,
        replacedTeacherId: replacedId,
        replacedTeacherName: replacedName,
        scheduledLessons: stale.length,
        movedLessons: moved,
      };
    });
  }

  /** Remove a subject offering from a class (the counterpart to assign — without
   *  it, a subject that was ever offered could never be deleted). */
  async removeClassSubject(p: Principal, classId: string, subjectId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      const removed = await tx.classSubjectTeacher.deleteMany({ where: { classId, subjectId } });
      if (removed.count === 0) throw new NotFoundException("That class does not offer this subject");
      await this.log(tx, p, "lms.class.subject.remove", "class", classId, { subjectId });
      return { ok: true };
    });
  }

  async listClassSubjects(p: Principal, classId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      const rows = await tx.classSubjectTeacher.findMany({
        where: { classId },
        include: {
          subject: { select: { id: true, name: true } },
          teacher: { select: { id: true, name: true } },
        },
        orderBy: { subject: { name: "asc" } },
      });
      return rows.map((r) => ({
        id: r.id,
        subjectId: r.subject.id,
        subjectName: r.subject.name,
        teacherId: r.teacher.id,
        teacherName: r.teacher.name,
        lessonsPerWeek: r.lessonsPerWeek,
        preferredRoomId: r.preferredRoomId,
      }));
    });
  }

  async assignTeacher(p: Principal, classId: string, teacherId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      const teacher = await tx.user.findFirst({ where: { id: teacherId }, select: { id: true } });
      if (!teacher) throw new NotFoundException("Teacher not found");
      // Idempotent: assigning twice is a duplicate click, not an error, and the
      // unique index would otherwise surface it as a raw 500.
      const row = await tx.classTeacher.upsert({
        where: { classId_teacherId: { classId, teacherId } },
        update: {},
        create: { schoolId: p.schoolId, classId, teacherId },
      });
      await this.log(tx, p, "lms.teacher.assign", "class", classId, { teacherId });
      return row;
    });
  }

  /**
   * Take a class teacher off a class.
   *
   * There was NO way to do this. A class-teacher assignment is the widest
   * relationship in the product — it grants the roster, the grades, the
   * documents, and the right to publish untagged content to every pupil in the
   * class — and it could be granted and never taken back. A mis-click, a change
   * of form teacher, or a member of staff moving on all left standing access
   * with no route to revoke it. Assigning without revoking is not an
   * assignment, it is a one-way grant.
   *
   * Deliberately NOT guarded on "the last teacher": a class with no teacher yet
   * is a normal state (it is how every class starts), so refusing would make
   * fixing a mistake impossible in exactly the case you most need to.
   */
  async removeTeacher(p: Principal, classId: string, teacherId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      // 404-not-403, and the same answer whether the class or the assignment is
      // missing — never disclose which.
      const existing = await tx.classTeacher.findFirst({
        where: { classId, teacherId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException("That teacher is not assigned to this class");
      await tx.classTeacher.delete({ where: { id: existing.id } });
      await this.log(tx, p, "lms.teacher.remove", "class", classId, { teacherId });
      return { classId, teacherId, removed: true };
    });
  }

  /**
   * Copy this class's subject set onto every OTHER arm of the same stream.
   *
   * This is the whole reason streams and arms are structured. Six arms of SS3
   * Science times twelve subjects is seventy-two assignments done by hand, and
   * the errors are not evenly spread: the last arm gets the tired admin. Set
   * one arm up correctly, then apply it.
   *
   * SUBJECTS copy; TEACHERS do not have to. Each arm normally has its own
   * teacher for the same subject, so a copied row carries this class's teacher
   * only as a starting point and `skipDuplicates` means an arm that already has
   * that subject KEEPS its own teacher. Copying over a correct assignment would
   * be worse than not copying at all.
   *
   * Cost is two statements regardless of how many arms: one indexed read for
   * the siblings (schoolId, stage, level, stream) and one createMany.
   */
  async copySubjectsToArms(p: Principal, classId: string): Promise<{ arms: number; created: number }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const source = (await tx.class.findFirst({
        where: { id: classId },
        select: { id: true, stage: true, level: true, stream: true, name: true },
      })) as { id: string; stage: string | null; level: number | null; stream: string | null; name: string } | null;
      if (!source) throw new NotFoundException("Class not found");
      if (!source.stage || source.level == null) {
        throw new BadRequestException("Set this class's stage and year before copying its subjects to other arms.");
      }

      const siblings = (await tx.class.findMany({
        where: {
          id: { not: classId },
          stage: source.stage,
          level: source.level,
          stream: source.stream,
        },
        select: { id: true },
      })) as Array<{ id: string }>;
      if (siblings.length === 0) {
        throw new BadRequestException(`${source.name} has no other arms to copy to.`);
      }

      const offerings = (await tx.classSubjectTeacher.findMany({
        where: { classId },
        select: { subjectId: true, teacherId: true, lessonsPerWeek: true },
      })) as Array<{ subjectId: string; teacherId: string; lessonsPerWeek: number | null }>;
      if (offerings.length === 0) {
        throw new BadRequestException(`${source.name} has no subjects to copy.`);
      }

      // ONE insert for every (arm x subject). skipDuplicates is what makes this
      // safe to run twice and what protects an arm's existing teacher.
      const res = await tx.classSubjectTeacher.createMany({
        data: siblings.flatMap((sib) =>
          offerings.map((o) => ({
            schoolId: p.schoolId,
            classId: sib.id,
            subjectId: o.subjectId,
            teacherId: o.teacherId,
            lessonsPerWeek: o.lessonsPerWeek ?? undefined,
          })),
        ),
        skipDuplicates: true,
      });
      await this.log(tx, p, "lms.class.subjects.copy-to-arms", "class", classId, {
        arms: siblings.length,
        subjects: offerings.length,
        created: res.count,
      });
      return { arms: siblings.length, created: res.count };
    });
  }

  /**
   * Assign MANY subjects to one class in a single transaction — the whole set a
   * class offers, set in one action instead of one request per subject.
   *
   * ALL-OR-NOTHING by design: every subject and teacher is validated before
   * anything is written, so a bad id in row 7 cannot leave rows 1-6 applied and
   * the roster half-built. Existing offerings are upserted, so re-running it is
   * how you change a teacher rather than a duplicate-key error.
   */
  async assignClassSubjectsBulk(
    p: Principal,
    classId: string,
    items: { subjectId: string; teacherId: string; lessonsPerWeek?: number; preferredRoomId?: string | null }[],
  ): Promise<{ assigned: number }> {
    if (items.length === 0) throw new BadRequestException("Nothing to assign");
    const dupes = items.length - new Set(items.map((i) => i.subjectId)).size;
    if (dupes > 0) throw new BadRequestException("The same subject appears more than once");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      // Validate EVERYTHING first (two set-queries, not two per row).
      const subjectIds = [...new Set(items.map((i) => i.subjectId))];
      const teacherIds = [...new Set(items.map((i) => i.teacherId))];
      const [subjects, teachers] = await Promise.all([
        tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true } }),
        tx.user.findMany({ where: { id: { in: teacherIds } }, select: { id: true } }),
      ]);
      if (subjects.length !== subjectIds.length) throw new NotFoundException("Subject not found");
      if (teachers.length !== teacherIds.length) throw new NotFoundException("Teacher not found");
      const roomIds = [...new Set(items.map((i) => i.preferredRoomId).filter((r): r is string => !!r))];
      if (roomIds.length > 0) {
        const rooms = await tx.room.findMany({ where: { id: { in: roomIds } }, select: { id: true } });
        if (rooms.length !== roomIds.length) throw new NotFoundException("Room not found");
      }
      for (const it of items) {
        await tx.classSubjectTeacher.upsert({
          where: { classId_subjectId: { classId, subjectId: it.subjectId } },
          update: {
            teacherId: it.teacherId,
            lessonsPerWeek: it.lessonsPerWeek,
            preferredRoomId: it.preferredRoomId === undefined ? undefined : it.preferredRoomId,
          },
          create: {
            schoolId: p.schoolId,
            classId,
            subjectId: it.subjectId,
            teacherId: it.teacherId,
            lessonsPerWeek: it.lessonsPerWeek ?? 1,
            preferredRoomId: it.preferredRoomId ?? null,
          },
        });
      }
      await this.log(tx, p, "lms.class.subjects.bulk_assign", "class", classId, { count: items.length });
      return { assigned: items.length };
    });
  }

  /**
   * Enrol MANY students into one class in a single transaction.
   *
   * Capacity is checked ONCE for the whole batch (not per student, which would
   * let a batch straddle the limit), students already enrolled are skipped rather
   * than erroring, and every id is validated up-front so a bad one can't leave a
   * partial roster behind.
   */
  async enrollStudentsBulk(p: Principal, classId: string, studentIds: string[]): Promise<{ enrolled: number; skipped: number }> {
    const ids = [...new Set(studentIds)];
    if (ids.length === 0) throw new BadRequestException("Nothing to enrol");
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      // Same rule as the single enrol: in this school, and actually a student.
      await this.requireStudents(tx, ids);
      // Already-enrolled students are a no-op, not a failure — re-running a roster
      // import must be safe.
      const existing = await tx.enrollment.findMany({ where: { classId, studentId: { in: ids } }, select: { studentId: true } });
      const already = new Set(existing.map((e: { studentId: string }) => e.studentId));
      const toAdd = ids.filter((id) => !already.has(id));
      if (toAdd.length === 0) return { enrolled: 0, skipped: ids.length };
      // ONE capacity check for the whole batch.
      await this.assertCapacity(tx, classId, toAdd.length);
      await tx.enrollment.createMany({
        data: toAdd.map((studentId) => ({ schoolId: p.schoolId, classId, studentId })),
      });
      await this.log(tx, p, "lms.student.enroll.bulk", "class", classId, { enrolled: toAdd.length, skipped: already.size });
      return { enrolled: toAdd.length, skipped: already.size };
    });
  }

  /**
   * The ids must name PUPILS OF THIS SCHOOL.
   *
   * `enrollStudent` checked the class and took the student id on trust. Against
   * the running system that meant:
   *
   *   201  a TEACHER as a pupil
   *   201  a pupil from ANOTHER school
   *   201  the platform SYSTEM account
   *
   * An enrolment is not a label either: it puts that account on the class
   * register to be marked present or absent, on the roster, in the report-card
   * run and in the capacity count — and it grants every teacher of the class
   * relationship-scoped access to them.
   *
   * // SECURITY: the read goes through the tenant client, so RLS confines it and
   * a user from another school is NOT FOUND rather than refused (Golden Rule
   * #3 — ids from a request body are never trusted).
   *
   * Returns the names so callers can put them in an error a person can act on.
   */
  private async requireStudents(tx: TenantTx, ids: string[]): Promise<Map<string, string>> {
    const users = (await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    })) as Array<{ id: string; name: string }>;
    const byId = new Map(users.map((u) => [u.id, u.name]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new NotFoundException("Student not found in this school");

    // ON ROLL, via the shared definition — never a hand-rolled role filter.
    // Enrolling somebody into a class is a decision about the PRESENT, so this
    // also refuses a pupil who has left the school, which a bare role check
    // would have let back onto a register.
    const onRoll = (await tx.user.findMany({
      where: { id: { in: ids }, ...ON_ROLL_STUDENT },
      select: { id: true },
    })) as Array<{ id: string }>;
    const eligible = new Set(onRoll.map((u) => u.id));
    const notStudents = ids.filter((id) => !eligible.has(id));
    if (notStudents.length) {
      const names = notStudents.map((id) => byId.get(id) ?? id).join(", ");
      throw new BadRequestException(
        `Cannot enrol ${names} — only pupils on roll can be put in a class.`,
      );
    }
    return byId;
  }

  async enrollStudent(p: Principal, classId: string, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      const names = await this.requireStudents(tx, [studentId]);
      // Enrolling somebody twice used to hit the (classId, studentId) unique
      // index and reach the client as a 500. It is the ordinary mistake when two
      // people are working a roster.
      const dup = await tx.enrollment.findFirst({
        where: { classId, studentId },
        select: { id: true, status: true },
      });
      if (dup) {
        const who = names.get(studentId) ?? "That pupil";
        throw new ConflictException(
          dup.status === "ACTIVE"
            ? `${who} is already in this class`
            : `${who} has a ${dup.status.toLowerCase()} enrolment in this class — reactivate it instead of adding a second one`,
        );
      }
      await this.assertCapacity(tx, classId, 1);
      const row = await tx.enrollment.create({
        data: { schoolId: p.schoolId, classId, studentId },
      });
      await this.log(tx, p, "lms.student.enroll", "class", classId, { studentId });
      return row;
    });
  }

  /** Transfer/withdraw a student: set an enrollment's status + reason (audited). */
  async setEnrollmentStatus(
    p: Principal,
    classId: string,
    studentId: string,
    status: "ACTIVE" | "TRANSFERRED" | "WITHDRAWN",
    reason?: string,
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const enr = await tx.enrollment.findFirst({ where: { classId, studentId }, select: { id: true } });
      if (!enr) throw new NotFoundException("Enrollment not found");
      // Reactivating must still respect capacity.
      if (status === "ACTIVE") await this.assertCapacity(tx, classId, 1);
      else {
        // THE BACK DOOR THIS CLOSES. This endpoint answers "is this pupil in
        // THIS class" — a roster edit, one permission, one person, and rightly
        // so when a child was put in the wrong class. But taking them out of
        // their LAST class is not a roster edit: they vanish from every
        // register, every print run and every classmate list, while their
        // account stays ACTIVE and they can still sign in. That is an exit
        // performed by one person with none of an exit's guarantees — and
        // `enrollment.write` is held by junior_admin, the tier defined by
        // having no approval powers.
        //
        // So the last one is refused and pointed at the two-stage exit, which
        // is the only thing that actually ends access.
        const otherActive = await tx.enrollment.count({
          where: { studentId, status: "ACTIVE", NOT: { id: enr.id } },
        });
        if (otherActive === 0) {
          throw new ConflictException(
            "This is the student's only class. Leaving the school is a Student exit request — it needs a second approval from the principal, and it ends their sign-in access.",
          );
        }
      }
      const updated = await tx.enrollment.update({
        where: { id: enr.id },
        data: { status, statusReason: reason ?? null },
      });
      await this.log(tx, p, "lms.enrollment.status", "class", classId, { studentId, status });
      return updated;
    });
  }

  /** Throw 409 if adding `adding` active enrollments would exceed the class capacity. */
  /**
   * Refuse an enrolment that would overfill the class.
   *
   * The count and the insert that follows it are made atomic by locking the
   * CLASS row first — the same thing hostel allocation does for a room, and for
   * the same reason: two racers both read `active + adding <= capacity` for the
   * last places and both insert, and the class ends up over its limit with
   * nothing in the log to say how.
   *
   * It is not hypothetical here. The bulk enrolment form sends a whole staged
   * list in one request, so a double-click is two batches of twenty-four
   * arriving together, each seeing an empty class of thirty.
   *
   * A class with no capacity set is unlimited and takes no lock — there is
   * nothing to serialise, and locking every enrolment into every uncapped class
   * would be a contention point for no gain.
   */
  private async assertCapacity(tx: TenantTx, classId: string, adding: number) {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { capacity: true } });
    if (!cls || cls.capacity == null) return; // unlimited
    // Serialises concurrent enrolments into THIS class for the rest of the
    // transaction. RLS still applies; the class is this tenant's by the caller's
    // own scope check.
    await tx.$executeRaw`SELECT id FROM "class" WHERE id = ${classId}::uuid FOR UPDATE`;
    const active = await tx.enrollment.count({ where: { classId, status: "ACTIVE" } });
    if (active + adding > cls.capacity) {
      throw new ConflictException(`Class is at capacity (${cls.capacity})`);
    }
  }

  /**
   * Attach a guardian ACCOUNT to a pupil.
   *
   * This decides who receives the child's absence alerts, invoices, receipts and
   * report cards, and who may open their fees, grades, attendance and documents.
   * It used to be a bare `create` on two ids taken from the request body, with
   * nothing checked at all. Every one of these was accepted with a 201:
   *
   *   201  a TEACHER as the guardian
   *   201  the pupil as their OWN guardian
   *   201  the platform SYSTEM account, which is in another org entirely
   *   500  the SAME pair twice   <- unique violation, straight to the client
   *
   * // SECURITY: ids in a request body are never trusted (Golden Rule #3). Both
   * users are re-read through the tenant client, so RLS confines them to the
   * caller's school and anyone else is simply NOT FOUND — 404, never a 403 that
   * would confirm the id belongs to somebody.
   *
   * The role checks make the API agree with the picker the UI already uses
   * (`UserPicker kind="parent"`). A member of staff who is also a parent at the
   * school is a normal thing and is supported — roles are additive, so give
   * that account the parent role; the refusal says so rather than leaving the
   * office guessing.
   */
  async linkGuardian(p: Principal, parentId: string, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (parentId === studentId) {
        throw new BadRequestException("A pupil cannot be their own guardian");
      }
      const [parent, student] = await Promise.all([
        tx.user.findFirst({ where: { id: parentId }, select: { id: true, name: true } }),
        tx.user.findFirst({ where: { id: studentId }, select: { id: true, name: true } }),
      ]);
      if (!parent) throw new NotFoundException("Guardian account not found in this school");
      if (!student) throw new NotFoundException("Student not found in this school");

      const roles = (await tx.userRole.findMany({
        where: { userId: { in: [parentId, studentId] }, role: { name: { in: ["parent", "student"] } } },
        select: { userId: true, role: { select: { name: true } } },
      })) as Array<{ userId: string; role: { name: string } }>;
      const has = (userId: string, name: string) =>
        roles.some((r) => r.userId === userId && r.role.name === name);
      if (!has(studentId, "student")) {
        throw new BadRequestException(`${student.name} is not a student`);
      }
      if (!has(parentId, "parent")) {
        throw new BadRequestException(
          `${parent.name} does not have the parent role. Give them that role first — an account can hold it alongside a staff role.`,
        );
      }

      // A duplicate is the ordinary mistake now that the link form sits beside
      // the list of existing guardians. It used to hit the unique index and
      // reach the client as a 500.
      const existing = (await tx.parentChild.findMany({
        where: { studentId },
        select: { parentId: true },
      })) as Array<{ parentId: string }>;
      if (existing.some((l) => l.parentId === parentId)) {
        throw new ConflictException(`${parent.name} is already linked to ${student.name}`);
      }

      // THE CAP. Each link is an access grant to a child's records, so the list
      // is bounded — see MAX_GUARDIANS_PER_STUDENT for why the number is not 2.
      //
      // The refusal NAMES who is already attached. At the cap the office has to
      // remove somebody, and the one thing that must not happen is a blind swap:
      // unlinking the mother to make room silently stops her absence alerts and
      // invoices, and the next person to look sees a tidy list with no sign
      // anything was taken away. Showing the four names makes it a decision.
      if (existing.length >= MAX_GUARDIANS_PER_STUDENT) {
        const names = (
          (await tx.user.findMany({
            where: { id: { in: existing.map((l) => l.parentId) } },
            select: { name: true },
            orderBy: { name: "asc" },
          })) as Array<{ name: string }>
        ).map((u) => u.name);
        throw new ConflictException(
          `${student.name} already has the maximum of ${MAX_GUARDIANS_PER_STUDENT} linked guardians (${names.join(", ")}). Remove one before adding ${parent.name}.`,
        );
      }

      const row = await tx.parentChild.create({
        data: { schoolId: p.schoolId, parentId, studentId },
      });
      await this.log(tx, p, "lms.guardian.link", "user", studentId, { parentId });
      return row;
    });
  }

  /**
   * Remove a guardian link.
   *
   * There was no way to do this. A link could be created — by this service or by
   * the bulk parent import — and never removed by anything: no endpoint, no raw
   * SQL, nothing. Proven against the running system: a principal linked an
   * unrelated adult to a pupil in one call, that adult immediately reached the
   * child's profile, invoices and documents, and both plausible DELETE routes
   * answered 404 because neither existed. The only remedy was somebody running
   * DELETE against the production database.
   *
   * That is not an edge case. A picker mis-click, a bad row in an import, a
   * step-parent no longer in the child's life, a custody order, a safeguarding
   * direction — all of them need this, and the last two need it TODAY.
   *
   * // SECURITY: this decides who can see a minor's records, so it is audited
   * like the link. It is deliberately NOT maker-checker and sends the removed
   * guardian NO notification: linking takes one person, so unlinking must not
   * take two and wait, and telling somebody they have just been removed from a
   * child's record is precisely the wrong thing to do in the case this exists
   * for. The remaining guardians are not told either — the school knows, and the
   * audit log records who did it.
   *
   * Removing the LAST guardian is allowed. A wrong sole link has to be
   * removable, and the pupil record already says plainly when nobody is linked.
   */
  async unlinkGuardian(p: Principal, parentId: string, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // RLS confines this to the caller's school, so a foreign link is simply
      // not found — 404, never 403, and never a hint that it exists elsewhere.
      const link = await tx.parentChild.findFirst({
        where: { parentId, studentId },
        select: { id: true },
      });
      if (!link) throw new NotFoundException("Guardian link not found");
      await tx.parentChild.delete({ where: { id: link.id } });
      await this.log(tx, p, "lms.guardian.unlink", "user", studentId, { parentId });
      return { removed: true as const };
    });
  }

  // --- relationship-scoped reads --------------------------------------------
  /** Classes the caller may see, narrowed by their role + memberships. */
  async listMyClasses(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) => this.visibleClasses(tx, p));
  }

  /**
   * THE definition of "classes this caller may see", shared by the plain list and
   * the overview.
   *
   * It lives in one place deliberately: two copies of a visibility rule drift, and
   * when a scoping rule drifts the failure is silent — one page shows a teacher a
   * class the other hides, and neither looks broken.
   */
  private async visibleClasses(tx: TenantTx, p: Principal) {
    {
      // principal / school_admin / HR see every class (to pick one + view its roster).
      if (this.isRosterWide(p)) {
        return tx.class.findMany({ orderBy: { name: "asc" } });
      }
      const classIds = new Set<string>();
      const taught = await tx.classTeacher.findMany({
        where: { teacherId: p.userId },
        select: { classId: true },
      });
      taught.forEach((t: { classId: string }) => classIds.add(t.classId));
      // A subject teacher who isn't the form teacher still "has" the class.
      const subjectTaught = await tx.classSubjectTeacher.findMany({
        where: { teacherId: p.userId },
        select: { classId: true },
      });
      subjectTaught.forEach((t: { classId: string }) => classIds.add(t.classId));
      // The class's named supervisor (form teacher) — so a supervisor sees the
      // class they oversee even when they teach none of its subjects (needed for
      // the class broadsheet / score sheet).
      const supervised = await tx.class.findMany({
        where: { supervisorId: p.userId },
        select: { id: true },
      });
      supervised.forEach((c: { id: string }) => classIds.add(c.id));
      const enrolled = await tx.enrollment.findMany({
        where: { studentId: p.userId },
        select: { classId: true },
      });
      enrolled.forEach((e: { classId: string }) => classIds.add(e.classId));
      const children = await tx.parentChild.findMany({
        where: { parentId: p.userId },
        select: { studentId: true },
      });
      if (children.length > 0) {
        const childEnroll = await tx.enrollment.findMany({
          where: { studentId: { in: children.map((c: { studentId: string }) => c.studentId) } },
          select: { classId: true },
        });
        childEnroll.forEach((e: { classId: string }) => classIds.add(e.classId));
      }
      if (classIds.size === 0) return [];
      return tx.class.findMany({ where: { id: { in: [...classIds] } }, orderBy: { name: "asc" } });
    }
  }

  /**
   * The caller's classes, each with the figures somebody manages a school by.
   *
   * The classes page rendered a class name and its raw UUID. A UUID is not a fact
   * about a class — it told a head of school nothing about who is responsible for
   * the room, how many children are in it, or whether it is over capacity. This is
   * the same relationship scoping as listMyClasses, with the numbers attached.
   *
   * FOUR grouped queries for the whole page, whatever the class count: roll,
   * teachers, subjects, and supervisor names. Counting by looping the classes and
   * asking per class is how this page would become slow at exactly the schools
   * large enough to need it.
   */
  async listClassOverview(p: Principal): Promise<ClassOverviewDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const classes = (await this.visibleClasses(tx, p)) as Array<{
        id: string;
        name: string;
        code: string | null;
        level: number | null;
        capacity: number | null;
        nextClassId: string | null;
        supervisorId: string | null;
        stage: string | null;
        stream: string | null;
        arm: string | null;
      }>;
      if (classes.length === 0) return [];
      const ids = classes.map((c) => c.id);

      const [rolls, teachers, offerings] = await Promise.all([
        // ACTIVE only: a promoted or withdrawn pupil is not in the room, and a roll
        // that counts them makes capacity meaningless.
        tx.enrollment.groupBy({
          by: ["classId"],
          where: { classId: { in: ids }, status: "ACTIVE" },
          _count: { _all: true },
        } as never) as unknown as Promise<Array<{ classId: string; _count: { _all: number } }>>,
        tx.classTeacher.groupBy({
          by: ["classId"],
          where: { classId: { in: ids } },
          _count: { _all: true },
        } as never) as unknown as Promise<Array<{ classId: string; _count: { _all: number } }>>,
        // The offerings THEMSELVES rather than a count of them. This replaces a
        // raw COUNT query — the subject total is derived from these rows, so
        // showing who teaches what on the list costs no extra round trip.
        // Still ONE query for every class on the page, never one per class.
        tx.classSubjectTeacher.findMany({
          where: { classId: { in: ids } },
          select: { classId: true, subjectId: true, teacherId: true },
        }) as Promise<Array<{ classId: string; subjectId: string; teacherId: string }>>,
      ]);

      // Two more batched lookups to name what we just read — constant, never per
      // class. Supervisors and subject teachers resolve in ONE user query: they
      // are both people, and splitting them would double the round trips to
      // answer the same question.
      const personIds = [
        ...new Set([
          ...classes.map((c) => c.supervisorId).filter((x): x is string => !!x),
          ...offerings.map((o) => o.teacherId),
        ]),
      ];
      const [subjectRows, personRows] = await Promise.all([
        offerings.length
          ? (tx.subject.findMany({
              where: { id: { in: [...new Set(offerings.map((o) => o.subjectId))] } },
              select: { id: true, name: true },
            }) as Promise<Array<{ id: string; name: string }>>)
          : Promise.resolve([] as Array<{ id: string; name: string }>),
        personIds.length
          ? (tx.user.findMany({
              where: { id: { in: personIds } },
              select: { id: true, name: true },
            }) as Promise<Array<{ id: string; name: string }>>)
          : Promise.resolve([] as Array<{ id: string; name: string }>),
      ]);
      const subjName = new Map(subjectRows.map((r) => [r.id, r.name]));
      const teachName = new Map(personRows.map((r) => [r.id, r.name]));

      const pairsBy = new Map<string, Array<{ subjectId: string; subjectName: string; teacherId: string; teacherName: string }>>();
      for (const o of offerings) {
        const list = pairsBy.get(o.classId) ?? [];
        list.push({
          subjectId: o.subjectId,
          subjectName: subjName.get(o.subjectId) ?? "Unknown subject",
          teacherId: o.teacherId,
          teacherName: teachName.get(o.teacherId) ?? "Unassigned",
        });
        pairsBy.set(o.classId, list);
      }
      // Alphabetical so the same class reads the same way every load — an order
      // that shifts between renders makes a list impossible to scan.
      for (const list of pairsBy.values()) list.sort((a, b) => a.subjectName.localeCompare(b.subjectName));

      const rollBy = new Map(rolls.map((r) => [r.classId, r._count._all]));
      const teachBy = new Map(teachers.map((r) => [r.classId, r._count._all]));
      const supBy = teachName;

      return classes.map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code,
        level: c.level,
        nextClassId: c.nextClassId,
        supervisorId: c.supervisorId,
        supervisorName: c.supervisorId ? supBy.get(c.supervisorId) ?? null : null,
        students: rollBy.get(c.id) ?? 0,
        capacity: c.capacity,
        teachers: teachBy.get(c.id) ?? 0,
        subjects: (pairsBy.get(c.id) ?? []).length,
        subjectTeachers: pairsBy.get(c.id) ?? [],
        stage: c.stage,
        stream: c.stream,
        arm: c.arm,
      }));
    });
  }

  /** The students the caller may see (id + name): self / their children / the
   *  students in classes they teach / ALL students by role (school-wide staff).
   *  Powers the student pickers in the SIS, attendance, and fees UIs. */
  /**
   * How many students the caller can see, as a COUNT.
   *
   * This exists so the roster LIST can finally be capped. The list was deliberately
   * left uncapped because the admin dashboard derived its student tile from
   * `.length` of it — so the whole roster was shipped to five pages (admin,
   * students, certificates, documents, classes) to render one number and four
   * pickers. Counting in Postgres removes the reason to ship it.
   *
   * Same definition of "student" as the list: by ROLE, not by enrolment, so a
   * freshly created student who has not been placed in a class yet still counts —
   * and it matches the billing seat count (one meaning of "student" platform-wide).
   */
  async countStudents(p: Principal): Promise<{ students: number }> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      if (this.isRosterWide(p)) {
        const students = (await tx.user.count({ where: ON_ROLL_STUDENT })) as number;
        return { students };
      }
      // Relationship-scoped callers: the count must match what listStudents would
      // return them, so reuse it rather than re-deriving the membership rules and
      // risking the two drifting apart.
      const rows = await this.listStudents(p);
      return { students: rows.length };
    });
  }

  async listStudents(p: Principal, q?: string) {
    // scale: an optional `q` typeahead narrows the roster server-side and caps the
    // result (SEARCH_CAP). The unsearched whole-school path is ALSO capped now —
    // it used to be uncapped on purpose, because the admin dashboard counted this
    // list, but that tile reads countStudents() instead, so nothing depends on the
    // list being complete any more. Pure read → replica path (Phase 1).
    const search = q?.trim();
    const nameFilter: { name?: { contains: string; mode: "insensitive" } } = search
      ? { name: { contains: search, mode: "insensitive" } }
      : {};
    const searchLimit: { take?: number } = search ? { take: SEARCH_CAP } : {};
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      if (this.isRosterWide(p)) {
        // Whole-school staff (ROSTER_WIDE_ROLES: admin/principal/HR) see EVERY
        // student in the tenant — by ROLE, not by enrollment. Deriving from
        // enrollments hid freshly created (not yet enrolled) students from
        // /students, so admission paperwork (SIS profile/contacts/medical)
        // couldn't be completed before class placement. Role-based also matches
        // the billing seat-count definition (ONE meaning of "student"
        // platform-wide) and is a single relation-filtered query instead of a
        // two-step ID-set round trip.
        return tx.user.findMany({
          // ON ROLL: a picker must not offer a pupil who has left as someone to
          // enrol, invoice or message.
          where: { ...ON_ROLL_STUDENT, ...nameFilter },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          // Bounded either way: SEARCH_CAP when narrowing, ROSTER_CAP otherwise.
          // Anything that needs a COUNT calls countStudents(); anything that needs a
          // specific student searches for them.
          ...(searchLimit.take ? searchLimit : { take: ROSTER_CAP }),
        });
      }
      // Relationship-scoped callers (teacher/parent/student): membership joins
      // narrow the rows, exactly as before.
      const ids = new Set<string>();
      if (p.roles.includes("student")) ids.add(p.userId);
      const taught = await tx.classTeacher.findMany({
        where: { teacherId: p.userId },
        select: { classId: true },
      });
      if (taught.length > 0) {
        const enr = await tx.enrollment.findMany({
          where: { classId: { in: taught.map((t: { classId: string }) => t.classId) } },
          select: { studentId: true },
          distinct: ["studentId"],
        });
        enr.forEach((e: { studentId: string }) => ids.add(e.studentId));
      }
      const children = await tx.parentChild.findMany({
        where: { parentId: p.userId },
        select: { studentId: true },
      });
      children.forEach((c: { studentId: string }) => ids.add(c.studentId));
      if (ids.size === 0) return [];
      return tx.user.findMany({
        where: { id: { in: [...ids] }, ...nameFilter },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        ...searchLimit,
      });
    });
  }

  /** A staff-facing tenant user directory (id + name + role names) for the admin
   *  pickers (assign teacher, link guardian, send notification). Tenant-scoped by
   *  RLS; the endpoint is gated by class.write so only staff reach it.
   *  `kind` narrows by role CATEGORY server-side so a staff/teacher picker never
   *  mixes in students or parents: "staff" = any role except student/parent
   *  (data-driven — a new seeded staff role is automatically included). */
  async listUsers(p: Principal, kind?: UserKind, q?: string) {
    const roleFilter =
      kind === "teacher"
        ? { some: { role: { name: "teacher" } } }
        : kind === "parent"
          ? { some: { role: { name: "parent" } } }
          : kind === "staff"
            ? { some: { role: { name: { notIn: [...NON_STAFF_ROLE_NAMES] } } } }
            : kind === "meeting-host"
              ? {
                  some: {
                    role: {
                      name: { notIn: [...NON_STAFF_ROLE_NAMES] },
                      permissions: { some: { permission: { key: MEETING_PERMISSIONS.MEETING_HOST } } },
                    },
                  },
                }
              : undefined;
    const needle = q?.trim();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const [users, roles] = await Promise.all([
        tx.user.findMany({
          where: {
            ...(roleFilter ? { roles: roleFilter } : {}),
            ...(needle
              ? {
                  OR: [
                    { name: { contains: needle, mode: "insensitive" as const } },
                    { email: { contains: needle, mode: "insensitive" as const } },
                  ],
                }
              : {}),
          },
          select: { id: true, name: true, email: true, roles: { select: { roleId: true } } },
          orderBy: { name: "asc" },
          // BOUNDED. This was uncapped, which is fine for ~80 staff and not fine for
          // the parent directory: a 3,000-pupil school has thousands of guardians,
          // and the classes page fetched every one of them on every load to fill a
          // single dropdown. Searching (`?q=`) is how you reach the rest.
          take: needle ? SEARCH_CAP : ROSTER_CAP,
        }),
        tx.role.findMany({ select: { id: true, name: true } }),
      ]);
      const roleName = new Map(roles.map((r: { id: string; name: string }) => [r.id, r.name]));
      return users.map((u: { id: string; name: string; email: string; roles: { roleId: string }[] }) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        roles: u.roles.map((r) => roleName.get(r.roleId)).filter((x): x is string => Boolean(x)),
      }));
    });
  }

  /** Roster of a class. Only a teacher OF THAT class or a school admin may read it. */
  async getClassRoster(p: Principal, classId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cls = await tx.class.findFirst({ where: { id: classId } });
      if (!cls) throw new NotFoundException("Class not found");

      if (!this.isRosterWide(p)) {
        // A class member is: a class teacher, the class supervisor, or a teacher
        // of one of the class's subjects. HR/principal reach this via role perms.
        const isSupervisor = cls.supervisorId === p.userId;
        const teaches = isSupervisor
          ? { id: "supervisor" }
          : await tx.classTeacher.findFirst({ where: { classId, teacherId: p.userId }, select: { id: true } });
        const teachesSubject =
          teaches ?? (await tx.classSubjectTeacher.findFirst({ where: { classId, teacherId: p.userId }, select: { id: true } }));
        // SECURITY: 404 (not 403) — don't reveal a class the caller can't see.
        if (!teachesSubject) throw new NotFoundException("Class not found");
      }

      // BY NAME. A roster with no `orderBy` comes back in whatever order the
      // rows happen to sit in, which for a class of thirty is thirty names in
      // no order at all — and this is the list a teacher scans to find one
      // pupil. Ordering a relation by a field of the related row is what
      // `orderBy: { student: { name } }` is for; sorting after the fact would
      // be wrong the moment this list is capped.
      const [teachers, students] = await Promise.all([
        tx.classTeacher.findMany({
          where: { classId },
          include: { teacher: { select: { id: true, name: true, email: true } } },
          orderBy: { teacher: { name: "asc" } },
        }),
        tx.enrollment.findMany({
          where: { classId, status: "ACTIVE" },
          include: { student: { select: { id: true, name: true, email: true } } },
          orderBy: { student: { name: "asc" } },
        }),
      ]);
      // Golden Rule #5: a roster is minors' PII — the read is audit-logged.
      await this.log(tx, p, "lms.roster.read", "class", classId, { students: students.length });
      return {
        class: cls,
        teachers: teachers.map((t: { teacher: unknown }) => t.teacher),
        students: students.map((e: { student: unknown }) => e.student),
      };
    });
  }

  /** Member-facing class info (parent/student/teacher see their class's subjects,
   *  teachers, and supervisor — NOT the full classmate roster). 404 to non-members. */
  async getClassInfo(p: Principal, classId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cls = await tx.class.findFirst({ where: { id: classId } });
      if (!cls) throw new NotFoundException("Class not found");

      if (!this.isRosterWide(p)) {
        // Members: enrolled student, a parent of an enrolled child, a class/subject
        // teacher, or the supervisor.
        let member = cls.supervisorId === p.userId;
        if (!member) member = Boolean(await tx.enrollment.findFirst({ where: { classId, studentId: p.userId }, select: { id: true } }));
        if (!member) member = Boolean(await tx.classTeacher.findFirst({ where: { classId, teacherId: p.userId }, select: { id: true } }));
        if (!member) member = Boolean(await tx.classSubjectTeacher.findFirst({ where: { classId, teacherId: p.userId }, select: { id: true } }));
        if (!member) {
          const children = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
          if (children.length) {
            member = Boolean(
              await tx.enrollment.findFirst({
                where: { classId, studentId: { in: children.map((c) => c.studentId) } },
                select: { id: true },
              }),
            );
          }
        }
        if (!member) throw new NotFoundException("Class not found"); // 404 not 403
      }

      const [subjects, supervisor] = await Promise.all([
        tx.classSubjectTeacher.findMany({
          where: { classId },
          include: { subject: { select: { name: true } }, teacher: { select: { name: true } } },
          orderBy: { subject: { name: "asc" } },
        }),
        cls.supervisorId
          ? tx.user.findFirst({ where: { id: cls.supervisorId }, select: { name: true } })
          : Promise.resolve(null),
      ]);
      return {
        id: cls.id,
        name: cls.name,
        supervisorName: supervisor?.name ?? null,
        subjects: subjects.map((s) => ({ subjectName: s.subject.name, teacherName: s.teacher.name })),
      };
    });
  }

  /** Promotion eligibility signal: per-student average published score (%) and
   *  attendance (%) for a class. A SIGNAL for a human decision — never a verdict
   *  (Golden Rule #8). Staff-only (roster-wide). */
  async getClassEligibility(p: Principal, classId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
      if (!cls) throw new NotFoundException("Class not found");
      if (!this.isRosterWide(p)) throw new NotFoundException("Class not found");

      const enrolled = await tx.enrollment.findMany({
        where: { classId, status: "ACTIVE" },
        include: { student: { select: { id: true, name: true } } },
      });
      const studentIds = enrolled.map((e: { studentId: string }) => e.studentId);
      if (studentIds.length === 0) return [];

      // Published grades for this class's assessments, per student.
      const grades = await tx.grade.findMany({
        where: { status: "PUBLISHED", submission: { assessment: { classId }, studentId: { in: studentIds } } },
        select: { score: true, maxScore: true, submission: { select: { studentId: true } } },
      });
      const gradeAgg = new Map<string, { sum: number; n: number }>();
      for (const g of grades as Array<{ score: number; maxScore: number; submission: { studentId: string } }>) {
        if (!g.maxScore) continue;
        const cur = gradeAgg.get(g.submission.studentId) ?? { sum: 0, n: 0 };
        cur.sum += (g.score / g.maxScore) * 100;
        cur.n += 1;
        gradeAgg.set(g.submission.studentId, cur);
      }

      // Attendance for this class's sessions, per student.
      const records = await tx.attendanceRecord.findMany({
        where: { studentId: { in: studentIds }, session: { classId } },
        select: { status: true, studentId: true },
      });
      const attAgg = new Map<string, { present: number; total: number }>();
      for (const r of records as Array<{ status: string; studentId: string }>) {
        const cur = attAgg.get(r.studentId) ?? { present: 0, total: 0 };
        cur.total += 1;
        if (r.status !== "ABSENT") cur.present += 1; // PRESENT/LATE/EXCUSED count as attended
        attAgg.set(r.studentId, cur);
      }

      return enrolled
        .map((e: { student: { id: string; name: string } }) => {
          const g = gradeAgg.get(e.student.id);
          const a = attAgg.get(e.student.id);
          return {
            studentId: e.student.id,
            name: e.student.name,
            averageScore: g && g.n ? Math.round((g.sum / g.n) * 10) / 10 : null,
            attendancePercent: a && a.total ? Math.round((a.present / a.total) * 1000) / 10 : null,
          };
        })
        .sort((x, y) => x.name.localeCompare(y.name));
    });
  }

  // --- helpers ---------------------------------------------------------------
  private async requireClass(tx: TenantTx, classId: string) {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { id: true } });
    if (!cls) throw new NotFoundException("Class not found");
    return cls;
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entity: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.audit.record(
      { actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
