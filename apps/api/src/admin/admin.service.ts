// =============================================================================
// AdminService — tenant-scoped RBAC (user↔role) + bulk student import
// =============================================================================
// Role->permission mappings are GLOBAL (super_admin concern); this service only
// manages TENANT-scoped assignments: which existing roles a user in THIS school
// holds, and bulk-creating student users. All audited.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

export interface ImportRow {
  name: string;
  email: string;
  classId?: string | null;
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  async listRoles(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) => tx.role.findMany({ select: { name: true }, orderBy: { name: "asc" } }));
  }

  async assignRole(p: Principal, userId: string, roleName: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const role = await tx.role.findFirst({ where: { name: roleName }, select: { id: true } });
      if (!role) throw new NotFoundException("Role not found");
      const user = await tx.user.findFirst({ where: { id: userId }, select: { id: true } });
      if (!user) throw new NotFoundException("User not found");
      const assignment = await tx.userRole.upsert({
        where: { userId_roleId: { userId, roleId: role.id } },
        update: {},
        create: { schoolId: p.schoolId, userId, roleId: role.id },
      });
      await this.log(tx, p, "rbac.role.assign", userId, { roleName });
      return assignment;
    });
  }

  async removeRole(p: Principal, userId: string, roleName: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const role = await tx.role.findFirst({ where: { name: roleName }, select: { id: true } });
      if (!role) throw new NotFoundException("Role not found");
      await tx.userRole.deleteMany({ where: { userId, roleId: role.id } });
      await this.log(tx, p, "rbac.role.remove", userId, { roleName });
      return { userId, roleName, removed: true };
    });
  }

  /** Bulk-create student users + assign the student role + (optionally) enroll. */
  async importStudents(p: Principal, rows: ImportRow[]) {
    if (!rows.length) throw new BadRequestException("No rows to import");
    // Imported users get a temporary password; in production they'd receive a
    // set-password link. Here it's the demo password for consistency.
    const passwordHash = await bcrypt.hash("password123", 10);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const studentRole = await tx.role.findFirst({ where: { name: "student" }, select: { id: true } });
      if (!studentRole) throw new NotFoundException("student role missing");
      let created = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (const row of rows) {
        try {
          const existing = await tx.user.findFirst({ where: { email: row.email }, select: { id: true } });
          if (existing) { skipped++; continue; }
          const u = await tx.user.create({
            data: { schoolId: p.schoolId, email: row.email, name: row.name, passwordHash },
          });
          await tx.userRole.create({ data: { schoolId: p.schoolId, userId: u.id, roleId: studentRole.id } });
          if (row.classId) {
            await tx.enrollment.create({ data: { schoolId: p.schoolId, classId: row.classId, studentId: u.id } });
          }
          created++;
        } catch (err) {
          errors.push(`${row.email}: ${String(err).slice(0, 80)}`);
        }
      }
      await this.log(tx, p, "admin.import.students", p.schoolId, { created, skipped, errors: errors.length });
      return { created, skipped, errors };
    });
  }

  private async log(
    tx: import("../integrity/integrity.foundation").TenantTx,
    p: Principal,
    action: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.audit.record(
      { actorId: p.userId, action, entity: "user", entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
