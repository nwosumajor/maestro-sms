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
import type { SearchResultDto, SearchHitDto } from "@sms/types";
import {
  TENANT_DATABASE,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const PER_CATEGORY = 6;
const ROSTER_WIDE = new Set(["school_admin", "principal", "super_admin", "board", "accountant", "hr_clerk", "hr_manager", "junior_admin"]);
const STAFF_WIDE = new Set(["school_admin", "principal", "super_admin"]);

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
      if (this.has(p, "student.profile.read") || this.has(p, "grade.read") || this.has(p, "class.read")) {
        const studentIds = await this.visibleStudentIds(tx, p);
        const where = studentIds === "all"
          ? { roles: { some: { role: { name: "student" } } }, name: like }
          : { id: { in: studentIds }, name: like };
        const students = await tx.user.findMany({ where, select: { id: true, name: true, email: true }, take: PER_CATEGORY });
        for (const s of students) {
          hits.push({ kind: "student", id: s.id, title: s.name, subtitle: s.email, href: `/students/${s.id}` });
        }
      }

      // --- staff (staff-wide only) ---
      if (p.roles.some((r) => STAFF_WIDE.has(r)) || this.has(p, "rbac.manage") || this.has(p, "hr.read")) {
        const staff = await tx.user.findMany({
          where: { name: like, roles: { some: { role: { name: { notIn: ["student", "parent"] } } } } },
          select: { id: true, name: true, email: true, roles: { select: { role: { select: { name: true } } } } },
          take: PER_CATEGORY,
        });
        for (const u of staff) {
          const roleNames = u.roles.map((r: { role: { name: string } }) => r.role.name).join(", ");
          hits.push({ kind: "staff", id: u.id, title: u.name, subtitle: roleNames || u.email, href: `/admin/roles` });
        }
      }

      // --- classes ---
      if (this.has(p, "class.read")) {
        const classes = await tx.class.findMany({ where: { name: like }, select: { id: true, name: true }, take: PER_CATEGORY });
        for (const c of classes) {
          hits.push({ kind: "class", id: c.id, title: c.name, subtitle: null, href: `/timetable?classId=${c.id}` });
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
