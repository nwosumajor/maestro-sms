// =============================================================================
// AdminService — tenant-scoped RBAC (user↔role) + bulk student import
// =============================================================================
// Role->permission mappings are GLOBAL (super_admin concern); this service only
// manages TENANT-scoped assignments: which existing roles a user in THIS school
// holds, and bulk-creating student users. All audited.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { isPlatformTierRole } from "@sms/types";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

export interface ImportRow {
  name: string;
  email: string;
  classId?: string | null;
}

// The platform/operator tier — NEVER mintable, modifiable or even VISIBLE to a
// school-level admin. Derived from the permission map (isPlatformTierRole = the
// role carries any `platform.*` permission) rather than hand-listed: the old
// hand-maintained list only named super_admin, so when `manager_admin` was
// added as a platform role nobody updated it — leaving a principal/school_admin
// able to grant SEVEN cross-tenant platform permissions. Deriving it means a
// future platform role is covered automatically.
// SECURITY: only super_admin administers these roles.
const isNonAssignableRole = (roleName: string) => isPlatformTierRole(roleName);

// The roles that carry `rbac.manage` (see role-map.ts) — the ability to
// administer role assignments. Removals of these are guarded below so a school
// can never strip itself of every administrator.
const RBAC_MANAGING_ROLES = new Set(["school_admin", "principal"]);

// The junior admin tier: any role grant that TOUCHES it (appointing a
// junior_admin, or stacking further roles onto one) is maker-checker — raised
// here as an ADMIN_APPOINTMENT workflow request and applied only after a
// DIFFERENT workflow.review holder (the other senior) approves.
const JUNIOR_ADMIN_ROLE = "junior_admin";

@Injectable()
export class AdminService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly workflow: WorkflowService,
    private readonly privileged: PrivilegedDatabaseService,
    hooks: WorkflowHooksService,
  ) {
    // Maker-checker reactor: when a DIFFERENT senior approves an
    // ADMIN_APPOINTMENT, the role grant lands in the SAME tenant tx as the
    // transition (atomic, idempotent via upsert). The initiator is the actor.
    hooks.onFinalized(async (tx, req) => {
      if (req.type !== "ADMIN_APPOINTMENT" || req.state !== "APPROVED") return;
      const pl = req.payload as { userId?: string; roleName?: string } | null;
      if (!pl?.userId || !pl.roleName || isNonAssignableRole(pl.roleName)) return;
      const role = await tx.role.findFirst({ where: { name: pl.roleName }, select: { id: true } });
      const user = await tx.user.findFirst({ where: { id: pl.userId }, select: { id: true } });
      if (!role || !user) return; // target vanished since request — no-op, never cross-tenant
      await tx.userRole.upsert({
        where: { userId_roleId: { userId: pl.userId, roleId: role.id } },
        update: {},
        create: { schoolId: req.schoolId, userId: pl.userId, roleId: role.id },
      });
      await this.audit.record(
        {
          actorId: req.initiatorId,
          action: "rbac.role.assign",
          entity: "user",
          entityId: pl.userId,
          schoolId: req.schoolId,
          metadata: { roleName: pl.roleName, workflowRequestId: req.id, makerChecker: true },
        },
        tx,
      );
    });
  }

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Roles a caller may administer. Platform-tier roles (super_admin,
   *  manager_admin — anything carrying a `platform.*` permission) are HIDDEN
   *  from school-level admins: they cannot see them in the picker, and the
   *  assign/remove paths refuse them independently. */
  async listRoles(p: Principal) {
    const rows = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.role.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
    );
    if (p.roles.includes("super_admin")) return rows;
    return rows.filter((r: { name: string }) => !isPlatformTierRole(r.name));
  }

  /** List this school's users with their roles (staff picker / directory). */
  async listUsers(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const users = await tx.user.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          uniqueId: true,
          name: true,
          email: true,
          status: true,
          roles: { select: { role: { select: { name: true } } } },
        },
      });
      return users.map((u) => ({
        id: u.id,
        uniqueId: u.uniqueId,
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
    if (isNonAssignableRole(roleName)) {
      // 404-shaped message: a school-level admin should not learn that a
      // platform role exists at all.
      throw new NotFoundException("Role not found");
    }
    const tempPassword = input.password ?? Math.random().toString(36).slice(2, 12);
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const pendingRole = roleName === JUNIOR_ADMIN_ROLE;
    const created = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const role = await tx.role.findFirst({ where: { name: roleName }, select: { id: true } });
      if (!role) throw new NotFoundException("Role not found");
      const existing = await tx.user.findFirst({ where: { email: input.email }, select: { id: true } });
      if (existing) throw new BadRequestException("That email is already in use");
      const user = await tx.user.create({
        data: { schoolId: p.schoolId, email: input.email, name: input.name, passwordHash },
      });
      // Maker-checker on the junior-admin tier: the ACCOUNT is created (it can
      // log in and do nothing — roles:[]) but the role lands only after a
      // different senior approves the ADMIN_APPOINTMENT raised below.
      if (!pendingRole) {
        await tx.userRole.create({ data: { schoolId: p.schoolId, userId: user.id, roleId: role.id } });
      }
      await this.log(tx, p, "admin.user.create", user.id, {
        email: input.email,
        role: roleName,
        ...(pendingRole ? { pendingAppointment: true } : {}),
      });
      return user;
    });
    if (pendingRole) {
      const pending = await this.raiseAppointment(p, created.id, input.name, roleName);
      return { id: created.id, email: input.email, role: roleName, tempPassword, ...pending };
    }
    return { id: created.id, email: input.email, role: roleName, tempPassword };
  }

  async assignRole(p: Principal, userId: string, roleName: string) {
    if (isNonAssignableRole(roleName)) {
      // 404-shaped message: a school-level admin should not learn that a
      // platform role exists at all.
      throw new NotFoundException("Role not found");
    }
    const target = await this.db.runAsTenant(this.ctx(p), async (tx) => {
      const role = await tx.role.findFirst({ where: { name: roleName }, select: { id: true } });
      if (!role) throw new NotFoundException("Role not found");
      const user = await tx.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
      if (!user) throw new NotFoundException("User not found");
      const holdsJunior = await tx.userRole.findFirst({
        where: { userId, role: { name: JUNIOR_ADMIN_ROLE } },
        select: { id: true },
      });
      return { user, guarded: roleName === JUNIOR_ADMIN_ROLE || Boolean(holdsJunior) };
    });
    // Grants touching the junior-admin tier are maker-checker: raise the
    // request; the grant lands via the finalized hook after a DIFFERENT
    // senior approves. Everything else stays a direct, audited assignment.
    if (target.guarded) {
      return this.raiseAppointment(p, userId, target.user.name, roleName);
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const role = await tx.role.findFirst({ where: { name: roleName }, select: { id: true } });
      if (!role) throw new NotFoundException("Role not found");
      const assignment = await tx.userRole.upsert({
        where: { userId_roleId: { userId, roleId: role.id } },
        update: {},
        create: { schoolId: p.schoolId, userId, roleId: role.id },
      });
      await this.log(tx, p, "rbac.role.assign", userId, { roleName });
      return assignment;
    });
  }

  /** Raise + submit the ADMIN_APPOINTMENT request for a junior-tier grant. */
  private async raiseAppointment(p: Principal, userId: string, userName: string, roleName: string) {
    const req = (await this.workflow.createRequest(p, {
      type: "ADMIN_APPOINTMENT",
      title: `Assign role ${roleName} to ${userName}`,
      payload: { userId, roleName },
    })) as { id: string };
    await this.workflow.submit(p, req.id);
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.log(tx, p, "rbac.role.assign.requested", userId, { roleName, workflowRequestId: req.id }),
    );
    return { pendingApproval: true as const, requestId: req.id, userId, roleName };
  }

  async removeRole(p: Principal, userId: string, roleName: string) {
    // SECURITY: platform-tier roles are the platform owner's to administer —
    // a school-level admin can neither grant NOR revoke them.
    if (isNonAssignableRole(roleName) && !p.roles.includes("super_admin")) {
      throw new NotFoundException("Role not found");
    }
    // SECURITY: demoting an administrator must always be a SECOND person's
    // deliberate act — never a self-inflicted (or accidental) lockout.
    if (userId === p.userId && RBAC_MANAGING_ROLES.has(roleName)) {
      throw new ConflictException("You cannot remove your own administrator role — another administrator must do it");
    }
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const role = await tx.role.findFirst({ where: { name: roleName }, select: { id: true } });
      if (!role) throw new NotFoundException("Role not found");
      if (RBAC_MANAGING_ROLES.has(roleName)) {
        // SECURITY: never leave the school with zero role-managing users (only
        // the operator could then recover it). Count every managing assignment
        // in this school EXCEPT the one being removed — RLS scopes the count.
        const remaining = await tx.userRole.count({
          where: {
            role: { name: { in: [...RBAC_MANAGING_ROLES] } },
            NOT: { userId, roleId: role.id },
          },
        });
        if (remaining === 0) {
          throw new ConflictException("Cannot remove the school's last administrator role");
        }
      }
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

  // --- school security policy: require MFA for all staff ----------------------
  async getMfaPolicy(p: Principal): Promise<{ requireStaffMfa: boolean }> {
    const school = await this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.school.findFirst({ where: { id: p.schoolId }, select: { requireStaffMfa: true } }),
    );
    return { requireStaffMfa: school?.requireStaffMfa ?? false };
  }

  /** Set the "all staff must enrol MFA" policy. The global `school` registry is
   *  SELECT-only for the app role, so the write uses the PRIVILEGED client
   *  (like settlement / late-fee config). Audited; step-up-gated at the
   *  controller. */
  async setMfaPolicy(p: Principal, requireStaffMfa: boolean): Promise<{ requireStaffMfa: boolean }> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Security policy requires the privileged database configuration");
    await client.school.update({ where: { id: p.schoolId }, data: { requireStaffMfa } });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        { actorId: p.userId, action: "admin.security.require_staff_mfa", entity: "school", entityId: p.schoolId, schoolId: p.schoolId, metadata: { requireStaffMfa } },
        tx,
      ),
    );
    return { requireStaffMfa };
  }
}
