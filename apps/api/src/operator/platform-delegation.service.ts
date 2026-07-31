// =============================================================================
// PlatformDelegationService — the owner lends a duty, and takes it back
// =============================================================================
// Why this is not the JIT elevation path:
//
//   Elevation is BOTTOM-UP. A holder requests more power and a peer approves it.
//   Every platform.* permission is excluded from it (NON_ELEVATABLE_PERMISSIONS)
//   because a manager_admin requesting platform.tenants.write, approved by another
//   manager_admin, would make the whole owner/staff split theatre.
//
//   This is TOP-DOWN. The owner hands a specific duty to a specific manager for a
//   bounded window. No escalation is possible by construction: the grantor already
//   holds everything they can give away.
//
// Every safeguard here follows from that one asymmetry being the ONLY thing keeping
// it safe — so each is checked rather than assumed:
//   • only DELEGABLE_PLATFORM_PERMISSIONS, at write time AND at use time;
//   • only the owner may grant (platform.staff.manage, itself never delegable);
//   • never to yourself, and only to an actual platform manager;
//   • always bounded, never open-ended;
//   • revocable instantly, because the guard reads the DB rather than the token;
//   • every grant, revoke and USE audit-logged.
// =============================================================================

import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  DEFAULT_DELEGATION_DAYS,
  LENDABLE_PLATFORM_PERMISSIONS,
  MAX_DELEGATION_DAYS,
  PLATFORM_STAFF_ROLE,
  isDelegatablePlatformPermission,
  type PlatformDelegationDto,
} from "@sms/types";
import { hasLiveDelegation } from "../auth/platform-delegation.util";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = {
  id: string;
  userId: string;
  permission: string;
  reason: string;
  grantedById: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedById: string | null;
};

@Injectable()
export class PlatformDelegationService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** The permissions the owner is allowed to lend — the console renders this
   *  rather than hard-coding a list that could drift from what the API accepts. */
  lendable(): string[] {
    return [...LENDABLE_PLATFORM_PERMISSIONS];
  }

  /** Every delegation ever made, newest first, with live/expired computed here so
   *  the console and the permission guard cannot disagree about who holds what. */
  async list(p: Principal): Promise<PlatformDelegationDto[]> {
    return this.db.runAsTenantReadOnly(this.ctx(p), async (tx) => {
      const rows = (await tx.platformDelegation.findMany({
        orderBy: { createdAt: "desc" },
        take: 200,
      })) as Row[];
      if (rows.length === 0) return [];
      const ids = [
        ...new Set(rows.flatMap((r) => [r.userId, r.grantedById, ...(r.revokedById ? [r.revokedById] : [])])),
      ];
      const users = (await tx.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true },
      })) as Array<{ id: string; name: string; email: string }>;
      const by = new Map(users.map((u) => [u.id, u]));
      const now = Date.now();
      return rows.map((r) => {
        const active = !r.revokedAt && r.expiresAt.getTime() > now;
        return {
          id: r.id,
          userId: r.userId,
          userName: by.get(r.userId)?.name ?? "(unknown)",
          userEmail: by.get(r.userId)?.email ?? "",
          permission: r.permission,
          reason: r.reason,
          grantedById: r.grantedById,
          grantedByName: by.get(r.grantedById)?.name ?? "(unknown)",
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          revokedAt: r.revokedAt,
          revokedByName: r.revokedById ? by.get(r.revokedById)?.name ?? "(unknown)" : null,
          active,
          daysLeft: active ? Math.max(0, Math.ceil((r.expiresAt.getTime() - now) / DAY_MS)) : 0,
        };
      });
    });
  }

  /** Lend one duty to one platform manager for a bounded window. */
  async grant(
    p: Principal,
    input: { userId: string; permission: string; reason: string; days?: number },
  ): Promise<PlatformDelegationDto> {
    const permission = input.permission.trim();
    // FIRST GATE. Impersonation, pricing, credentials, student PII and hiring are
    // not lendable at any duration: lending one of them for a week is
    // indistinguishable from giving it away.
    if (!isDelegatablePlatformPermission(permission)) {
      throw new BadRequestException(
        `${permission} cannot be delegated. Only these may be lent: ${LENDABLE_PLATFORM_PERMISSIONS.join(", ")}`,
      );
    }
    // SECURITY: granting yourself a duty proves nothing and audits to the same
    // person on both sides. The owner already holds all of these anyway, so the
    // only reason to do it would be to muddy the trail.
    if (input.userId === p.userId) {
      throw new BadRequestException("A duty is delegated to someone else, not to yourself");
    }
    const days = Math.floor(input.days ?? DEFAULT_DELEGATION_DAYS);
    if (!Number.isFinite(days) || days < 1 || days > MAX_DELEGATION_DAYS) {
      throw new BadRequestException(`Choose between 1 and ${MAX_DELEGATION_DAYS} days`);
    }
    const reason = input.reason.trim();
    // A delegation with no stated reason is unreviewable six months later, which is
    // exactly when somebody asks why this person had this access.
    if (reason.length < 3) throw new BadRequestException("Give a reason — it is what makes the record reviewable");

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // The grantee must be an actual platform manager in the platform org. RLS has
      // already confined this lookup to that org, so a customer-school user simply
      // is not found — 404, never a cross-tenant disclosure.
      const target = await tx.user.findFirst({
        where: { id: input.userId },
        select: { id: true, name: true, email: true, roles: { select: { role: { select: { name: true } } } } },
      });
      if (!target) throw new NotFoundException("Platform manager not found");
      const roles = (target.roles as Array<{ role: { name: string } }>).map((r) => r.role.name);
      if (!roles.includes(PLATFORM_STAFF_ROLE)) {
        throw new BadRequestException("Duties can only be delegated to a platform manager");
      }

      // Re-granting a duty the person already holds live EXTENDS it rather than
      // stacking a second row — two live grants of the same permission would make
      // "when does this end" ambiguous, and revoking one would look like it worked.
      const existing = (await tx.platformDelegation.findFirst({
        where: { userId: input.userId, permission, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      })) as { id: string } | null;

      const expiresAt = new Date(Date.now() + days * DAY_MS);
      const row = (existing
        ? await tx.platformDelegation.update({
            where: { id: existing.id },
            data: { expiresAt, reason, grantedById: p.userId },
          })
        : await tx.platformDelegation.create({
            data: {
              schoolId: p.schoolId,
              userId: input.userId,
              permission,
              reason,
              grantedById: p.userId,
              expiresAt,
            },
          })) as Row;

      await this.audit.record(
        {
          actorId: p.userId,
          action: existing ? "platform.delegation.extend" : "platform.delegation.grant",
          entity: "user",
          entityId: input.userId,
          schoolId: p.schoolId,
          metadata: { permission, days, reason, expiresAt: expiresAt.toISOString(), to: target.email },
        },
        tx,
      );

      const now = Date.now();
      return {
        id: row.id,
        userId: row.userId,
        userName: target.name,
        userEmail: target.email,
        permission: row.permission,
        reason: row.reason,
        grantedById: row.grantedById,
        grantedByName: "you",
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        revokedAt: null,
        revokedByName: null,
        active: true,
        daysLeft: Math.max(0, Math.ceil((row.expiresAt.getTime() - now) / DAY_MS)),
      };
    });
  }

  /** Take a duty back early. Effective on the manager's very next request — the
   *  guard reads this table, so nothing waits for a token to expire. */
  async revoke(p: Principal, id: string): Promise<{ revoked: true }> {
    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      const row = (await tx.platformDelegation.findFirst({ where: { id } })) as Row | null;
      if (!row) throw new NotFoundException("Delegation not found");
      if (row.revokedAt) return { revoked: true as const }; // idempotent

      await tx.platformDelegation.update({
        where: { id },
        // Never hard-deleted: the row is the answer to "who had access on the day
        // that happened".
        data: { revokedAt: new Date(), revokedById: p.userId },
      });
      await this.audit.record(
        {
          actorId: p.userId,
          action: "platform.delegation.revoke",
          entity: "user",
          entityId: row.userId,
          schoolId: p.schoolId,
          metadata: { permission: row.permission, delegationId: id },
        },
        tx,
      );
      return { revoked: true as const };
    });
  }

  /**
   * Does this principal hold `permission` through a live delegation?
   *
   * Delegates to the SAME function the PermissionGuard uses — one implementation of
   * "is this loan live", so the console can never show a duty as active that the
   * guard would refuse, or the reverse.
   */
  async hasDelegation(tx: TenantTx, userId: string, permission: string): Promise<boolean> {
    return hasLiveDelegation(tx, userId, permission);
  }
}
