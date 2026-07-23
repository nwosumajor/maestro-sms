// =============================================================================
// AdminService — tenant-scoped RBAC (user↔role) + bulk student import
// =============================================================================
// Role->permission mappings are GLOBAL (super_admin concern); this service only
// manages TENANT-scoped assignments: which existing roles a user in THIS school
// holds, and bulk-creating student users. All audited.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { Prisma } from "@sms/db";
import { allocateLoginEmail, asNameTakenConflict, schoolSlugOf } from "../foundation/login-email";
import { allocateAdmissionNumber, loadUsedAdmissionNumbers } from "../foundation/admission-number";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { autoSuffixLoginOnClash, isPlatformTierRole, requiresContactEmail } from "@sms/types";
import { WorkflowService } from "../workflow/workflow.service";
import { WorkflowHooksService } from "../workflow/workflow-hooks.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

export interface ImportRow {
  name: string;
  /** Optional — omitted => generated from the name and the school's domain. */
  email?: string | null;
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
  async createUser(
    p: Principal,
    input: { name: string; email?: string; contactEmail?: string; role: string; password?: string },
  ) {
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
      // Staff and parents MUST have a reachable address: without one they can
      // never receive a reset link or an invite, and the account is
      // unrecoverable the first time they forget their password. Students are
      // exempt — their guardians are the ones notified.
      if (requiresContactEmail(roleName) && !input.contactEmail?.trim()) {
        throw new BadRequestException(
          `A contact email is required for a ${roleName} — it is where their sign-in invite, password resets and notices are sent.`,
        );
      }
      // No address supplied => GENERATE a school-scoped login identifier. Because
      // the school's unique slug is the subdomain, this can never collide with
      // another school — which is the whole point of the scheme.
      let loginEmail: string;
      if (input.email?.trim()) {
        loginEmail = input.email.trim().toLowerCase();
        const existing = await tx.user.findFirst({ where: { email: loginEmail }, select: { id: true } });
        if (existing) throw new BadRequestException("That email is already in use");
      } else {
        const slug = await schoolSlugOf(tx, p.schoolId);
        // Students and parents auto-suffix a name clash; staff are refused so a
        // colleague never gets a near-identical login. One rule in @sms/types.
        loginEmail = await allocateLoginEmail(tx, input.name, slug, {
          autoSuffix: autoSuffixLoginOnClash(roleName),
        });
      }
      const generated = !input.email?.trim();
      let user: { id: string; email: string };
      try {
        user = await tx.user.create({
          data: {
            schoolId: p.schoolId,
            email: loginEmail,
            contactEmail: input.contactEmail?.trim() || null,
            // Authoritative "this is not a mailbox" marker — see deliverableEmail().
            loginEmailGenerated: generated,
            name: input.name,
            passwordHash,
          },
        });
      } catch (e) {
        // A GENERATED identifier can only clash within this school (the slug is
        // the domain), so say so plainly. A SUPPLIED address may clash with a
        // user in another school, invisible to the RLS-scoped pre-check — that
        // one stays deliberately vague so it cannot be used to probe other
        // tenants for existence.
        if (generated) asNameTakenConflict(e, input.name);
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new ConflictException("That email is already in use");
        }
        throw e;
      }
      // Maker-checker on the junior-admin tier: the ACCOUNT is created (it can
      // log in and do nothing — roles:[]) but the role lands only after a
      // different senior approves the ADMIN_APPOINTMENT raised below.
      if (!pendingRole) {
        await tx.userRole.create({ data: { schoolId: p.schoolId, userId: user.id, roleId: role.id } });
      }
      // A STUDENT gets a profile + an auto-generated admission number, exactly as
      // bulk import does — otherwise a manually-created pupil has no admission
      // number and cannot be referenced (e.g. for parent linking). Same shared
      // allocator; a rare cross-tx race is caught by the DB unique constraint.
      let admissionNumber: string | null = null;
      if (roleName === "student") {
        const used = await loadUsedAdmissionNumbers(tx);
        admissionNumber = allocateAdmissionNumber(used, new Date().getFullYear());
        try {
          await tx.studentProfile.create({
            data: { schoolId: p.schoolId, studentId: user.id, admissionNumber },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
            throw new ConflictException("That admission number was just taken — please try again.");
          }
          throw e;
        }
      }
      await this.log(tx, p, "admin.user.create", user.id, {
        // The identifier actually issued — input.email is undefined when generated.
        email: user.email,
        role: roleName,
        ...(pendingRole ? { pendingAppointment: true } : {}),
      });
      return { ...user, admissionNumber };
    });
    if (pendingRole) {
      const pending = await this.raiseAppointment(p, created.id, input.name, roleName);
      return { id: created.id, email: created.email, role: roleName, tempPassword, admissionNumber: created.admissionNumber, ...pending };
    }
    return { id: created.id, email: created.email, role: roleName, tempPassword, admissionNumber: created.admissionNumber };
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
      const slug = await schoolSlugOf(tx, p.schoolId);
      const issued = new Set<string>();
      for (const row of rows) {
        try {
          const generated = !row.email?.trim();
          let loginEmail: string;
          if (generated) {
            // Students auto-suffix a shared name (adams.james2), so the import
            // never blocks on a common name.
            loginEmail = await allocateLoginEmail(tx, row.name, slug, { taken: issued, autoSuffix: true });
          } else {
            loginEmail = row.email!.trim().toLowerCase();
            if (issued.has(loginEmail)) {
              errors.push(`${row.name}: another row already uses ${loginEmail}`);
              skipped++;
              continue;
            }
            const existing = await tx.user.findFirst({ where: { email: loginEmail }, select: { id: true } });
            if (existing) { skipped++; continue; }
            issued.add(loginEmail);
          }
          const u = await tx.user.create({
            data: {
              schoolId: p.schoolId,
              email: loginEmail,
              loginEmailGenerated: generated,
              name: row.name,
              passwordHash,
            },
          });
          await tx.userRole.create({ data: { schoolId: p.schoolId, userId: u.id, roleId: studentRole.id } });
          if (row.classId) {
            await tx.enrollment.create({ data: { schoolId: p.schoolId, classId: row.classId, studentId: u.id } });
          }
          created++;
        } catch (err) {
          // A cross-school email collision surfaces here as a raw P2002. Translate
          // it — "Unique constraint failed on the fields: (`email`)" tells the
          // school administrator nothing they can act on.
          const msg =
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
              ? "that sign-in identifier is already taken — give this person a fuller name"
              : String(err).slice(0, 80);
          errors.push(`${row.name}: ${msg}`);
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
