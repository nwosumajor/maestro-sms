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

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
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

  // --- mutations (school_admin) ---------------------------------------------
  async createClass(p: Principal, input: { name: string; subject?: string }) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cls = await tx.class.create({
        data: { schoolId: p.schoolId, name: input.name, subject: input.subject ?? null },
      });
      await this.log(tx, p, "lms.class.create", "class", cls.id);
      return cls;
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
      const row = await tx.enrollment.create({
        data: { schoolId: p.schoolId, classId, studentId },
      });
      await this.log(tx, p, "lms.student.enroll", "class", classId, { studentId });
      return row;
    });
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
      if (this.isSchoolWide(p)) {
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
   *  students in classes they teach / all enrolled (school-wide). Powers the
   *  student pickers in the SIS, attendance, and fees UIs. */
  async listStudents(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const ids = new Set<string>();
      if (this.isSchoolWide(p)) {
        const enr = await tx.enrollment.findMany({
          select: { studentId: true },
          distinct: ["studentId"],
        });
        enr.forEach((e: { studentId: string }) => ids.add(e.studentId));
      } else {
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
      }
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
        roles: u.roles.map((r) => roleName.get(r.roleId)).filter(Boolean),
      }));
    });
  }

  /** Roster of a class. Only a teacher OF THAT class or a school admin may read it. */
  async getClassRoster(p: Principal, classId: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const cls = await tx.class.findFirst({ where: { id: classId } });
      if (!cls) throw new NotFoundException("Class not found");

      if (!this.isSchoolWide(p)) {
        const teaches = await tx.classTeacher.findFirst({
          where: { classId, teacherId: p.userId },
          select: { id: true },
        });
        // SECURITY: 404 (not 403) — don't reveal a class the caller can't see.
        if (!teaches) throw new NotFoundException("Class not found");
      }

      const [teachers, students] = await Promise.all([
        tx.classTeacher.findMany({
          where: { classId },
          include: { teacher: { select: { id: true, name: true, email: true } } },
        }),
        tx.enrollment.findMany({
          where: { classId },
          include: { student: { select: { id: true, name: true, email: true } } },
        }),
      ]);
      return {
        class: cls,
        teachers: teachers.map((t: { teacher: unknown }) => t.teacher),
        students: students.map((e: { student: unknown }) => e.student),
      };
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
