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
import {
  NON_STAFF_ROLE_NAMES,
  ROSTER_CAP,
  SEARCH_CAP,
  DEFAULT_CURRICULUM,
  normaliseEntityCode,
  subjectCatalogueFor,
  uniqueEntityCode,
  type ClassOverviewDto,
  type SubjectStage,
  type UserKind,
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
const ROSTER_WIDE_ROLES = new Set([
  "school_admin",
  "principal",
  "hr_manager",
  "hr_clerk",
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
    input: { name: string; level?: number | null; nextClassId?: string | null; code?: string | null },
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
        },
      });
      await this.log(tx, p, "lms.class.create", "class", cls.id);
      return cls;
    });
  }

  /** Update class progression / supervisor / metadata (school_admin). */
  async updateClass(
    p: Principal,
    classId: string,
    input: { name?: string; level?: number | null; nextClassId?: string | null; supervisorId?: string | null; capacity?: number | null },
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
        },
      });
      await this.log(tx, p, "lms.class.update", "class", classId, {
        supervisorId: input.supervisorId,
        level: input.level,
        nextClassId: input.nextClassId,
        capacity: input.capacity,
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

  /** Assign (or re-assign) a teacher to a class's subject offering, optionally
   *  with its CSP timetable inputs (weekly lesson quota + fixed room). */
  async assignClassSubject(
    p: Principal,
    classId: string,
    subjectId: string,
    teacherId: string,
    opts?: { lessonsPerWeek?: number; preferredRoomId?: string | null },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      const subj = await tx.subject.findFirst({ where: { id: subjectId }, select: { id: true } });
      if (!subj) throw new NotFoundException("Subject not found");
      const teacher = await tx.user.findFirst({ where: { id: teacherId }, select: { id: true } });
      if (!teacher) throw new NotFoundException("Teacher not found");
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
      await this.log(tx, p, "lms.class.subject.assign", "class", classId, {
        subjectId,
        teacherId,
        lessonsPerWeek: row.lessonsPerWeek,
        preferredRoomId: row.preferredRoomId,
      });
      return row;
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
      const row = await tx.classTeacher.create({
        data: { schoolId: p.schoolId, classId, teacherId },
      });
      await this.log(tx, p, "lms.teacher.assign", "class", classId, { teacherId });
      return row;
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
      const found = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
      if (found.length !== ids.length) throw new NotFoundException("Student not found");
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

  async enrollStudent(p: Principal, classId: string, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
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
      const updated = await tx.enrollment.update({
        where: { id: enr.id },
        data: { status, statusReason: reason ?? null },
      });
      await this.log(tx, p, "lms.enrollment.status", "class", classId, { studentId, status });
      return updated;
    });
  }

  /** Throw 409 if adding `adding` active enrollments would exceed the class capacity. */
  private async assertCapacity(tx: TenantTx, classId: string, adding: number) {
    const cls = await tx.class.findFirst({ where: { id: classId }, select: { capacity: true } });
    if (!cls || cls.capacity == null) return; // unlimited
    const active = await tx.enrollment.count({ where: { classId, status: "ACTIVE" } });
    if (active + adding > cls.capacity) {
      throw new ConflictException(`Class is at capacity (${cls.capacity})`);
    }
  }

  async linkGuardian(p: Principal, parentId: string, studentId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = await tx.parentChild.create({
        data: { schoolId: p.schoolId, parentId, studentId },
      });
      await this.log(tx, p, "lms.guardian.link", "user", studentId, { parentId });
      return row;
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
      }>;
      if (classes.length === 0) return [];
      const ids = classes.map((c) => c.id);

      const [rolls, teachers, offerings, supervisors] = await Promise.all([
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
        // DISTINCT subjects: one subject taught by two teachers is one offering on
        // the timetable, not two.
        tx.$queryRaw`
          SELECT "classId", count(DISTINCT "subjectId")::int AS subjects
          FROM class_subject_teacher
          WHERE "schoolId" = ${p.schoolId}::uuid
            AND "classId" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
          GROUP BY "classId"
        ` as Promise<Array<{ classId: string; subjects: number }>>,
        (async () => {
          const supIds = [...new Set(classes.map((c) => c.supervisorId).filter((x): x is string => !!x))];
          if (supIds.length === 0) return [] as Array<{ id: string; name: string }>;
          return (await tx.user.findMany({
            where: { id: { in: supIds } },
            select: { id: true, name: true },
          })) as Array<{ id: string; name: string }>;
        })(),
      ]);

      const rollBy = new Map(rolls.map((r) => [r.classId, r._count._all]));
      const teachBy = new Map(teachers.map((r) => [r.classId, r._count._all]));
      const subjBy = new Map(offerings.map((r) => [r.classId, r.subjects]));
      const supBy = new Map(supervisors.map((u) => [u.id, u.name]));

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
        subjects: subjBy.get(c.id) ?? 0,
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
        const students = (await tx.user.count({
          where: { roles: { some: { role: { name: "student" } } } },
        })) as number;
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
          where: { roles: { some: { role: { name: "student" } } }, ...nameFilter },
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

      const [teachers, students] = await Promise.all([
        tx.classTeacher.findMany({
          where: { classId },
          include: { teacher: { select: { id: true, name: true, email: true } } },
        }),
        tx.enrollment.findMany({
          where: { classId, status: "ACTIVE" },
          include: { student: { select: { id: true, name: true, email: true } } },
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
