// =============================================================================
// SecurityService — audit viewer + Just-In-Time privilege elevation
// =============================================================================
// Audit viewer: scoped, filtered reads of the append-only audit_log (with actor
// names resolved). Elevation: request -> approve (by a DIFFERENT person:
// separation of duties) -> auto-expire, or break-glass (self-activated, flagged).
// Every action is audit-logged. The PermissionGuard consults active grants on a
// permission miss (see hasActiveGrant equivalent in the guard).
// =============================================================================

import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { SECURITY_PERMISSIONS } from "@sms/types";
import { generateSecret, otpauthUri, verifyTotp } from "../auth/totp";
import { signStepUp } from "../auth/stepup";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const MAX_MINUTES = 480; // an elevation can last at most 8 hours

export interface AuditFilter {
  actorId?: string;
  action?: string;
  entity?: string;
  from?: string;
  to?: string;
  limit?: number;
}
export interface ElevationRequestInput {
  permission: string;
  reason: string;
  minutes?: number;
  breakGlass?: boolean;
}

@Injectable()
export class SecurityService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- audit viewer ----------------------------------------------------------
  async listAudit(p: Principal, f: AuditFilter) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const where: Record<string, unknown> = {};
      if (f.actorId) where.actorId = f.actorId;
      if (f.action) where.action = { contains: f.action };
      if (f.entity) where.entity = f.entity;
      if (f.from || f.to) {
        where.createdAt = {
          ...(f.from ? { gte: new Date(f.from) } : {}),
          ...(f.to ? { lte: new Date(f.to) } : {}),
        };
      }
      const rows = await tx.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(f.limit ?? 100, 500),
      });
      const actorIds = [...new Set(rows.map((r: { actorId: string }) => r.actorId))];
      const users = await tx.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      });
      const name = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
      return rows.map((r: { actorId: string }) => ({ ...r, actorName: name.get(r.actorId) ?? "system" }));
    });
  }

  // --- elevation -------------------------------------------------------------
  async requestElevation(p: Principal, input: ElevationRequestInput) {
    if (!input.permission || !input.reason) {
      throw new BadRequestException("permission and reason are required");
    }
    const minutes = Math.min(Math.max(input.minutes ?? 60, 1), MAX_MINUTES);
    const expiresAt = new Date(Date.now() + minutes * 60_000);

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const grant = await tx.privilegeGrant.create({
        data: {
          schoolId: p.schoolId,
          userId: p.userId,
          permission: input.permission,
          reason: input.reason,
          // Break-glass is active immediately (self-approved) and flagged for
          // alerting; a normal request waits for a different approver.
          status: input.breakGlass ? "ACTIVE" : "PENDING",
          breakGlass: Boolean(input.breakGlass),
          requestedById: p.userId,
          approvedById: input.breakGlass ? p.userId : null,
          expiresAt,
        },
      });
      await this.log(
        tx,
        p,
        input.breakGlass ? "security.elevation.breakglass" : "security.elevation.request",
        grant.id,
        { permission: input.permission, minutes },
      );
      return grant;
    });
  }

  async approveElevation(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const grant = await tx.privilegeGrant.findFirst({ where: { id } });
      if (!grant) throw new NotFoundException("Elevation request not found");
      if (grant.status !== "PENDING") {
        throw new BadRequestException(`Request is ${grant.status}, not pending`);
      }
      // SECURITY: separation of duties — the approver MUST differ from the requester.
      if (grant.requestedById === p.userId) {
        throw new ForbiddenException("You cannot approve your own elevation request");
      }
      const updated = await tx.privilegeGrant.update({
        where: { id },
        data: { status: "ACTIVE", approvedById: p.userId },
      });
      await this.log(tx, p, "security.elevation.approve", id, { permission: grant.permission });
      return updated;
    });
  }

  async revokeElevation(p: Principal, id: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const grant = await tx.privilegeGrant.findFirst({ where: { id } });
      if (!grant) throw new NotFoundException("Elevation request not found");
      if (grant.status === "REVOKED") return grant;
      const updated = await tx.privilegeGrant.update({ where: { id }, data: { status: "REVOKED" } });
      await this.log(tx, p, "security.elevation.revoke", id, { permission: grant.permission });
      return updated;
    });
  }

  async listElevations(p: Principal) {
    const canApprove = p.permissions.includes(SECURITY_PERMISSIONS.ELEVATION_APPROVE);
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.privilegeGrant.findMany({
        // Approvers see the whole tenant's grants; everyone else sees their own.
        where: canApprove ? {} : { userId: p.userId },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    );
  }

  // --- access recertification + anomalies ------------------------------------
  /** A governance snapshot for periodic review: every role's permissions, every
   *  user's role assignments, and all active elevations. */
  async recertification(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const roles = await tx.role.findMany({
        include: { permissions: { include: { permission: true } } },
        orderBy: { name: "asc" },
      });
      const userRoles = await tx.userRole.findMany({
        include: { user: { select: { id: true, name: true, email: true } }, role: { select: { name: true } } },
      });
      const activeElevations = await tx.privilegeGrant.findMany({
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      });

      const byUser = new Map<string, { id: string; name: string; email: string; roles: string[] }>();
      for (const ur of userRoles as Array<{ user: { id: string; name: string; email: string }; role: { name: string } }>) {
        const e = byUser.get(ur.user.id) ?? { ...ur.user, roles: [] };
        e.roles.push(ur.role.name);
        byUser.set(ur.user.id, e);
      }
      return {
        roles: (roles as Array<{ name: string; permissions: { permission: { key: string } }[] }>).map((r) => ({
          name: r.name,
          permissions: r.permissions.map((rp) => rp.permission.key).sort(),
        })),
        assignments: [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name)),
        activeElevations,
      };
    });
  }

  /** Lightweight anomaly signals over the recent audit log (for a human). */
  async anomalies(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const since = new Date(Date.now() - 30 * 86_400_000);
      const breakGlass = await tx.auditLog.findMany({
        where: { action: "security.elevation.breakglass", createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      const medReads = await tx.auditLog.findMany({
        where: { action: "sis.medical.read", createdAt: { gte: since } },
        select: { actorId: true },
      });
      const counts = new Map<string, number>();
      for (const r of medReads as Array<{ actorId: string }>) {
        counts.set(r.actorId, (counts.get(r.actorId) ?? 0) + 1);
      }
      const users = await tx.user.findMany({
        where: { id: { in: [...counts.keys()] } },
        select: { id: true, name: true },
      });
      const name = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
      const topMedicalReaders = [...counts.entries()]
        .map(([id, count]) => ({ actorName: name.get(id) ?? "?", count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      return { breakGlassCount: breakGlass.length, breakGlassEvents: breakGlass, topMedicalReaders };
    });
  }

  // --- MFA (TOTP) ------------------------------------------------------------
  async mfaStatus(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const u = await tx.user.findUnique({ where: { id: p.userId }, select: { mfaEnabled: true } });
      return { enabled: Boolean(u?.mfaEnabled) };
    });
  }

  /** Generate a secret and return the otpauth URI to scan. Not enabled until
   *  the user proves they can produce a code via verifyMfa. */
  async enrollMfa(p: Principal) {
    const secret = generateSecret();
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const u = await tx.user.findUnique({ where: { id: p.userId }, select: { email: true } });
      await tx.user.update({ where: { id: p.userId }, data: { mfaSecret: secret, mfaEnabled: false } });
      await this.log(tx, p, "security.mfa.enroll", p.userId);
      return { secret, otpauthUri: otpauthUri(u?.email ?? "user", secret) };
    });
  }

  async verifyMfa(p: Principal, code: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const u = await tx.user.findUnique({ where: { id: p.userId }, select: { mfaSecret: true } });
      if (!u?.mfaSecret) throw new BadRequestException("Start enrollment first");
      if (!verifyTotp(u.mfaSecret, code)) throw new BadRequestException("Invalid code");
      await tx.user.update({ where: { id: p.userId }, data: { mfaEnabled: true } });
      await this.log(tx, p, "security.mfa.enabled", p.userId);
      return { enabled: true };
    });
  }

  /** Turn MFA off. Gated by @RequireStepUp at the controller, and re-checks a code. */
  async disableMfa(p: Principal, code: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const u = await tx.user.findUnique({ where: { id: p.userId }, select: { mfaSecret: true, mfaEnabled: true } });
      if (!u?.mfaEnabled || !u.mfaSecret) return { enabled: false };
      if (!verifyTotp(u.mfaSecret, code)) throw new BadRequestException("Invalid code");
      await tx.user.update({ where: { id: p.userId }, data: { mfaEnabled: false, mfaSecret: null } });
      await this.log(tx, p, "security.mfa.disabled", p.userId);
      return { enabled: false };
    });
  }

  // --- step-up re-auth -------------------------------------------------------
  /** Re-verify the password and mint a short-lived step-up token. */
  async stepUp(p: Principal, password: string) {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const u = await tx.user.findUnique({ where: { id: p.userId }, select: { passwordHash: true } });
      if (!u || !(await bcrypt.compare(password, u.passwordHash))) {
        throw new UnauthorizedException("Re-authentication failed");
      }
      await this.log(tx, p, "security.stepup", p.userId);
      return signStepUp(p.userId, p.schoolId);
    });
  }

  private async log(
    tx: TenantTx,
    p: Principal,
    action: string,
    entityId: string,
    metadata?: Record<string, unknown>,
  ) {
    // security.mfa.* / security.stepup act on the user; elevation acts on the grant.
    const entity = action.startsWith("security.elevation") ? "privilege_grant" : "user";
    await this.audit.record(
      { actorId: p.userId, action, entity, entityId, schoolId: p.schoolId, metadata },
      tx,
    );
  }
}
