// =============================================================================
// SearchService — in-tenant global "jump to" search across modules
// =============================================================================
// A single omnibox that federates a few high-value entities: students, staff,
// classes and invoices. Each category is included ONLY when the caller holds
// the relevant read permission, and results stay tenant-isolated (RLS) and
// relationship-scoped where the module already scopes (students: whole-school
// staff see all, teachers their classes; a parent/student never searches other
// families). Read-only, capped per category, returns typed hits with a link.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import { ON_ROLL_STUDENT } from "../common/student-scope";
import type { SearchResultDto, SearchHitDto } from "@sms/types";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const PER_CATEGORY = 6;
// Kept in step with LmsService.ROSTER_WIDE_ROLES, which decides the same
// question for /students and /classes: search that disagrees with the page it
// links to is the drift this scoping is meant to prevent — head_teacher listing
// 31 classes on /classes and none in the omnibox is a bug either way round.
// The two sets are not identical, and that is deliberate: `accountant` is here
// for invoice lookup but holds no class.read, so the categories below gate them
// out by permission anyway.
const ROSTER_WIDE = new Set([
  "school_admin",
  "principal",
  "board",
  "accountant",
  "hr_clerk",
  "hr_manager",
  "junior_admin",
  "head_teacher",
]);
const STAFF_WIDE = new Set(["school_admin", "principal"]);

@Injectable()
export class SearchService {
  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  private has(p: Principal, perm: string): boolean {
    return p.permissions.includes(perm);
  }

  async search(p: Principal, rawQuery: string): Promise<SearchResultDto> {
    const q = rawQuery.trim();
    if (q.length < 2) return { query: q, hits: [] };
    const like = { contains: q, mode: "insensitive" as const };

    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const hits: SearchHitDto[] = [];

      // --- students (relationship-scoped) ---
      //
      // GATED ON WHAT THE DESTINATION REQUIRES, not on anything that implies an
      // interest in pupils. This read `student.profile.read || grade.read ||
      // class.read` and then linked to /students/:id, which requires
      // `student.profile.read` alone — so board, head_teacher, hr_clerk and
      // hr_manager were all offered pupils they could not open. Verified live
      // before the fix: a board member searching "Volume" got six pupils back
      // and the first one answered 403.
      //
      // This is the same defect the class category below was fixed for, and the
      // header of this file claims the whole scoping exists to prevent it. A
      // result that cannot be opened is worse than no result: it tells a user
      // the record exists and that they are being refused it.
      if (this.has(p, "student.profile.read")) {
        const studentIds = await this.visibleStudentIds(tx, p);
        const where = studentIds === "all"
          ? { ...ON_ROLL_STUDENT, name: like }
          : { id: { in: studentIds }, name: like };
        const students = await tx.user.findMany({ where, select: { id: true, name: true, email: true }, take: PER_CATEGORY });
        for (const s of students) {
          hits.push({ kind: "student", id: s.id, title: s.name, subtitle: s.email, href: `/students/${s.id}` });
        }
      }

      // --- staff (staff-wide only) ---
      //
      // The link follows the caller. Every hit pointed at /admin/roles, which
      // requires `rbac.manage` — so an HR clerk, who searches staff as their
      // actual job, was handed results that bounced them to the dashboard.
      // Sending them to the HR record instead keeps the capability rather than
      // removing it, which is the right trade when the person has a legitimate
      // reason to look and somewhere legitimate to look at.
      const canManageRoles = p.roles.some((r) => STAFF_WIDE.has(r)) || this.has(p, "rbac.manage");
      const canReadHr = this.has(p, "hr.read");
      if (canManageRoles || canReadHr) {
        const staff = await tx.user.findMany({
          where: { name: like, roles: { some: { role: { name: { notIn: ["student", "parent"] } } } } },
          select: { id: true, name: true, email: true, roles: { select: { role: { select: { name: true } } } } },
          take: PER_CATEGORY,
        });
        for (const u of staff) {
          const roleNames = u.roles.map((r: { role: { name: string } }) => r.role.name).join(", ");
          hits.push({
            kind: "staff",
            id: u.id,
            title: u.name,
            subtitle: roleNames || u.email,
            href: canManageRoles ? "/admin/roles" : `/hr/staff/${u.id}`,
          });
        }
      }

      // --- classes (relationship-scoped, like students above) ---
      // This category used to be a bare `class.read` check with NO narrowing, so
      // a PARENT searching "vol" got all six of the school's VOL classes back —
      // every class name and id in the school, none of them their child's. The
      // rows behind them were safe (getClassInfo 404s a non-member, the roster
      // needs enrollment.read), which made it worse rather than better: search
      // offered six results whose links open a page that silently shows nothing.
      //
      // The link follows the caller here too. A class hit pointed at
      // /timetable, which requires `timetable.read` — and head_teacher,
      // hr_clerk and hr_manager hold `class.read` WITHOUT it, so the narrowing
      // was right and the destination was still shut. /classes takes exactly
      // `class.read`, which is the permission that let them see the row at all.
      if (this.has(p, "class.read")) {
        const canOpenTimetable = this.has(p, "timetable.read");
        const classIds = await this.visibleClassIds(tx, p);
        if (classIds === "all" || classIds.length > 0) {
          const where = classIds === "all" ? { name: like } : { name: like, id: { in: classIds } };
          const classes = await tx.class.findMany({ where, select: { id: true, name: true }, take: PER_CATEGORY });
          for (const c of classes) {
            hits.push({
              kind: "class",
              id: c.id,
              title: c.name,
              subtitle: null,
              href: canOpenTimetable ? `/timetable?classId=${c.id}` : "/classes",
            });
          }
        }
      }

      // --- invoices (fee.read; scoped to visible students for non-billing-wide) ---
      if (this.has(p, "fee.read")) {
        const billingWide = p.roles.some((r) => ["accountant", "school_admin", "principal", "board", "super_admin"].includes(r));
        const scopedIds = billingWide ? null : await this.visibleStudentIds(tx, p);
        const where =
          scopedIds && scopedIds !== "all"
            ? { reference: like, studentId: { in: scopedIds } }
            : { reference: like };
        const invoices = await tx.invoice.findMany({ where, select: { id: true, reference: true, status: true }, take: PER_CATEGORY });
        for (const inv of invoices) {
          hits.push({ kind: "invoice", id: inv.id, title: inv.reference, subtitle: inv.status, href: `/fees/${inv.id}` });
        }
      }

      return { query: q, hits };
    });
  }

  /** "all" (whole-school staff) or the concrete class ids a relationship-scoped
   *  caller belongs to: classes they teach, are enrolled in, or their children
   *  are enrolled in. Mirrors LmsService.visibleClasses — a class the caller
   *  cannot open must not be offered to them as a search result. */
  private async visibleClassIds(tx: TenantTx, p: Principal): Promise<string[] | "all"> {
    if (p.roles.some((r) => ROSTER_WIDE.has(r))) return "all";
    const ids = new Set<string>();
    const taught = await tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } });
    taught.forEach((t: { classId: string }) => ids.add(t.classId));
    const subjectTaught = await tx.classSubjectTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } });
    subjectTaught.forEach((t: { classId: string }) => ids.add(t.classId));
    const supervised = await tx.class.findMany({ where: { supervisorId: p.userId }, select: { id: true } });
    supervised.forEach((c: { id: string }) => ids.add(c.id));
    // Own enrolments (a student) and their CHILDREN's (a parent) — deliberately
    // NOT visibleStudentIds, which for a teacher also contains the pupils they
    // teach. Following that set back to enrolments would hand a teacher every
    // OTHER class those pupils sit in, which is wider than LmsService allows.
    const family = new Set<string>();
    if (p.roles.includes("student")) family.add(p.userId);
    const kids = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
    kids.forEach((k: { studentId: string }) => family.add(k.studentId));
    if (family.size > 0) {
      const enr = await tx.enrollment.findMany({
        where: { studentId: { in: [...family] } },
        select: { classId: true },
        distinct: ["classId"],
      });
      enr.forEach((e: { classId: string }) => ids.add(e.classId));
    }
    return [...ids];
  }

  /** "all" (whole-school staff) or the concrete id set a relationship-scoped
   *  caller may see (own children / own classes / self). */
  private async visibleStudentIds(tx: TenantTx, p: Principal): Promise<string[] | "all"> {
    if (p.roles.some((r) => ROSTER_WIDE.has(r))) return "all";
    const ids = new Set<string>();
    if (p.roles.includes("student")) ids.add(p.userId);
    const kids = await tx.parentChild.findMany({ where: { parentId: p.userId }, select: { studentId: true } });
    kids.forEach((k: { studentId: string }) => ids.add(k.studentId));
    const taught = await tx.classTeacher.findMany({ where: { teacherId: p.userId }, select: { classId: true } });
    if (taught.length) {
      const enr = await tx.enrollment.findMany({
        where: { classId: { in: taught.map((t: { classId: string }) => t.classId) } },
        select: { studentId: true },
        distinct: ["studentId"],
      });
      enr.forEach((e: { studentId: string }) => ids.add(e.studentId));
    }
    return [...ids];
  }
}
