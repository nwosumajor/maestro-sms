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

// The platform/operator tier — NEVER mintable by a school-level admin. A
// school_admin/principal creating users must not be able to escalate a profile to
// cross-tenant super_admin. (All other roles are single-school-scoped by design.)
const NON_ASSIGNABLE_ROLES = new Set(["super_admin"]);

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

  /** List this school's users with their roles (staff picker / directory). */
  async listUsers(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const users = await tx.user.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          roles: { select: { role: { select: { name: true } } } },
        },
      });
      return users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        status: u.status,
        roles: u.roles.map((r) => r.role.name),
      }));
    });
  }

  /**
   * Create a single user profile within the CALLER's own school and assign one
   * role. RLS scopes every write to p.schoolId, so a school_admin can only ever
   * create users in their own tenant; the super_admin guard prevents minting a
   * cross-tenant operator. Returns a one-time temporary password.
   */
  async createUser(p: Principal, input: { name: string; email: string; role: string; password?: string }) {
    const roleName = input.role;
    if (NON_ASSIGNABLE_ROLES.has(roleName)) {
      throw new BadRequestException("That role cannot be assigned");
    }
    const tempPassword = input.password ?? Math.random().toString(36).slice(2, 12);
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const role = await tx.role.findFirst({ where: { name: roleName }, select: { id: true } });
      if (!role) throw new NotFoundException("Role not found");
      const existing = await tx.user.findFirst({ where: { email: input.email }, select: { id: true } });
      if (existing) throw new BadRequestException("That email is already in use");
      const user = await tx.user.create({
        data: { schoolId: p.schoolId, email: input.email, name: input.name, passwordHash },
      });
      await tx.userRole.create({ data: { schoolId: p.schoolId, userId: user.id, roleId: role.id } });
      await this.log(tx, p, "admin.user.create", user.id, { email: input.email, role: roleName });
      return { id: user.id, email: input.email, role: roleName, tempPassword };
    });
  }

  async assignRole(p: Principal, userId: string, roleName: string) {
    if (NON_ASSIGNABLE_ROLES.has(roleName)) {
      throw new BadRequestException("That role cannot be assigned");
    }
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
