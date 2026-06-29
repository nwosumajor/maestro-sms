// =============================================================================
// OperatorUserService — super_admin cross-tenant user directory + governance
// =============================================================================
// The platform owner must be able to SEE and GOVERN the people inside any school:
// list users, suspend/reactivate accounts, clear a lockout, reset a password,
// reset (disable) a user's 2FA, and MANDATE 2FA for a user or a whole role.
//
// Listing/mutating users across ARBITRARY tenants crosses the RLS boundary, which
// the least-privilege app role cannot do — so, exactly like OperatorProvisioning
// and the retention/dunning jobs, this connects through a PRIVILEGED client
// (DATABASE_MIGRATE_URL, else DATABASE_RETENTION_URL) that bypasses RLS by design.
// It is reachable ONLY from the platform.operate + step-up-gated operator routes,
// and every mutation is audit-logged in the OPERATOR's own tenant.
//
// Least-privilege default: with no privileged URL the client is null and the whole
// surface is DISABLED (503) rather than silently escalating.
//
// SECURITY: a super_admin user can NEVER be targeted by these operations (no
// cross-operator tamper, no self-suspend) — they are the platform's root tier.
// =============================================================================

import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@sms/db";
import type { OperatorUserDto } from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const SUPER_ADMIN = "super_admin";

@Injectable()
export class OperatorUserService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("OperatorUser");
  private _client: PrismaClient | null = null;

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  onModuleInit(): void {
    const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_RETENTION_URL;
    if (!url) {
      this.logger.warn(
        "No DATABASE_MIGRATE_URL / DATABASE_RETENTION_URL set — operator user management is DISABLED.",
      );
      return;
    }
    this._client = new PrismaClient({ datasourceUrl: url, log: ["error"] });
  }
  async onModuleDestroy(): Promise<void> {
    await this._client?.$disconnect();
  }

  private client(): PrismaClient {
    if (!this._client) {
      throw new ServiceUnavailableException("Operator user management is not configured");
    }
    return this._client;
  }

  private genPassword(): string {
    return crypto.randomBytes(9).toString("base64url");
  }

  /** Load a user (by id) and assert it exists, belongs to schoolId, and is not a super_admin. */
  private async loadGovernable(
    schoolId: string,
    userId: string,
  ): Promise<{ id: string; roles: string[] }> {
    const db = this.client();
    const user = await db.user.findFirst({
      where: { id: userId, schoolId },
      select: { id: true, roles: { select: { role: { select: { name: true } } } } },
    });
    if (!user) throw new NotFoundException("User not found");
    const roles = user.roles.map((r) => r.role.name);
    if (roles.includes(SUPER_ADMIN)) {
      // 404 not 403 — never reveal that the target is a protected operator account.
      throw new NotFoundException("User not found");
    }
    return { id: user.id, roles };
  }

  // --- reads -----------------------------------------------------------------
  async listUsers(schoolId: string): Promise<OperatorUserDto[]> {
    const db = this.client();
    const school = await db.school.findFirst({ where: { id: schoolId }, select: { id: true } });
    if (!school) throw new NotFoundException("School not found");
    const users = await db.user.findMany({
      where: { schoolId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        mfaEnabled: true,
        mfaRequired: true,
        lockedUntil: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      roles: u.roles.map((r) => r.role.name),
      status: u.status,
      mfaEnabled: u.mfaEnabled,
      mfaRequired: u.mfaRequired,
      lockedUntil: u.lockedUntil,
    }));
  }

  // --- mutations (all audited in the operator's own tenant) ------------------
  async setStatus(p: Principal, schoolId: string, userId: string, status: "ACTIVE" | "DISABLED") {
    await this.loadGovernable(schoolId, userId);
    await this.client().user.update({ where: { id: userId }, data: { status } });
    await this.auditInOperatorTenant(p, "operator.user.status", userId, { targetSchoolId: schoolId, status });
    return { id: userId, status };
  }

  async unlock(p: Principal, schoolId: string, userId: string) {
    await this.loadGovernable(schoolId, userId);
    await this.client().user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    await this.auditInOperatorTenant(p, "operator.user.unlock", userId, { targetSchoolId: schoolId });
    return { id: userId, unlocked: true };
  }

  /** Issue a fresh one-time password (forces a re-login). Returns it ONCE. */
  async resetPassword(p: Principal, schoolId: string, userId: string) {
    await this.loadGovernable(schoolId, userId);
    const tempPassword = this.genPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    await this.client().user.update({
      where: { id: userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
    await this.auditInOperatorTenant(p, "operator.user.password_reset", userId, {
      targetSchoolId: schoolId,
    });
    return { id: userId, tempPassword };
  }

  /** Clear a user's TOTP enrolment (e.g. lost authenticator). They re-enrol next login. */
  async resetMfa(p: Principal, schoolId: string, userId: string) {
    await this.loadGovernable(schoolId, userId);
    await this.client().user.update({
      where: { id: userId },
      data: { mfaSecret: null, mfaEnabled: false },
    });
    await this.auditInOperatorTenant(p, "operator.user.mfa_reset", userId, { targetSchoolId: schoolId });
    return { id: userId, mfaEnabled: false };
  }

  /** Mandate (or release) MFA for a single user. */
  async setMfaRequired(p: Principal, schoolId: string, userId: string, required: boolean) {
    await this.loadGovernable(schoolId, userId);
    await this.client().user.update({ where: { id: userId }, data: { mfaRequired: required } });
    await this.auditInOperatorTenant(p, "operator.user.mfa_required", userId, {
      targetSchoolId: schoolId,
      required,
    });
    return { id: userId, mfaRequired: required };
  }

  /** Mandate (or release) MFA for every (non-super_admin) user holding a role. */
  async setRoleMfaRequired(p: Principal, schoolId: string, roleName: string, required: boolean) {
    if (roleName === SUPER_ADMIN) throw new ConflictException("Cannot govern the super_admin role");
    const db = this.client();
    const role = await db.role.findFirst({ where: { name: roleName }, select: { id: true } });
    if (!role) throw new NotFoundException("Role not found");
    const result = await db.user.updateMany({
      where: { schoolId, roles: { some: { roleId: role.id } } },
      data: { mfaRequired: required },
    });
    await this.auditInOperatorTenant(p, "operator.role.mfa_required", roleName, {
      targetSchoolId: schoolId,
      roleName,
      required,
      affected: result.count,
    });
    return { roleName, required, affected: result.count };
  }

  /** Audit lands in the OPERATOR's own tenant (the actor FK is the operator). */
  private async auditInOperatorTenant(
    p: Principal,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action, entity: "user", entityId, schoolId: p.schoolId, metadata },
        tx,
      ),
    );
  }
}
