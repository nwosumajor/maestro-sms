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

import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const SCHOOL_WIDE_ROLES = new Set(["school_admin", "super_admin"]);
// Staff who may view ANY class roster / the full class list in their tenant
// (req: principal, school admin and HR can view all students in a specific class).
// Broader than SCHOOL_WIDE_ROLES, which also governs the student picker.
const ROSTER_WIDE_ROLES = new Set([
  "school_admin",
  "super_admin",
  "principal",
  "hr_manager",
  "hr_clerk",
]);

@Injectable()
export class LmsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }
  private isSchoolWide(p: Principal): boolean {
    return p.roles.some((r) => SCHOOL_WIDE_ROLES.has(r));
  }
  private isRosterWide(p: Principal): boolean {
    return p.roles.some((r) => ROSTER_WIDE_ROLES.has(r));
  }

  // --- mutations (school_admin) ---------------------------------------------
  async createClass(
    p: Principal,
    input: { name: string; subject?: string; level?: number | null; nextClassId?: string | null },
  ) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cls = await tx.class.create({
        data: {
          schoolId: p.schoolId,
          name: input.name,
          subject: input.subject ?? null,
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
    input: { name?: string; subject?: string | null; level?: number | null; nextClassId?: string | null; supervisorId?: string | null; capacity?: number | null },
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
          subject: input.subject === undefined ? undefined : input.subject,
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
  async createSubject(p: Principal, input: { name: string; code?: string | null }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const subj = await tx.subject.create({
        data: { schoolId: p.schoolId, name: input.name, code: input.code ?? null },
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

  /** Assign (or re-assign) a teacher to a class's subject offering. */
  async assignClassSubject(p: Principal, classId: string, subjectId: string, teacherId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      await this.requireClass(tx, classId);
      const subj = await tx.subject.findFirst({ where: { id: subjectId }, select: { id: true } });
      if (!subj) throw new NotFoundException("Subject not found");
      const teacher = await tx.user.findFirst({ where: { id: teacherId }, select: { id: true } });
      if (!teacher) throw new NotFoundException("Teacher not found");
      const row = await tx.classSubjectTeacher.upsert({
        where: { classId_subjectId: { classId, subjectId } },
        update: { teacherId },
        create: { schoolId: p.schoolId, classId, subjectId, teacherId },
      });
      await this.log(tx, p, "lms.class.subject.assign", "class", classId, { subjectId, teacherId });
      return row;
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
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
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
    });
  }

  /** The students the caller may see (id + name): self / their children / the
   *  students in classes they teach / ALL students by role (school-wide staff).
   *  Powers the student pickers in the SIS, attendance, and fees UIs. */
  async listStudents(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      if (this.isSchoolWide(p)) {
        // School-wide staff see EVERY student in the tenant — by ROLE, not by
        // enrollment. Deriving from enrollments hid freshly created (not yet
        // enrolled) students from /students, so admission paperwork (SIS
        // profile/contacts/medical) couldn't be completed before class
        // placement. Role-based also matches the billing seat-count definition
        // (ONE meaning of "student" platform-wide) and is a single relation-
        // filtered query instead of a two-step ID-set round trip.
        return tx.user.findMany({
          where: { roles: { some: { role: { name: "student" } } } },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
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
        where: { id: { in: [...ids] } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
    });
  }

  /** A staff-facing tenant user directory (id + name + role names) for the admin
   *  pickers (assign teacher, link guardian, send notification). Tenant-scoped by
   *  RLS; the endpoint is gated by class.write so only staff reach it. */
  async listUsers(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const [users, roles] = await Promise.all([
        tx.user.findMany({
          select: { id: true, name: true, email: true, roles: { select: { roleId: true } } },
          orderBy: { name: "asc" },
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
