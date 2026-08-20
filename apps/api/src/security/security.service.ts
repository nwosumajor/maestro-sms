// =============================================================================
// SecurityService — audit viewer + Just-In-Time privilege elevation
// =============================================================================
// Audit viewer: scoped, filtered reads of the append-only audit_log (with actor
// names resolved). Elevation: request -> approve (by a DIFFERENT person:
// separation of duties) -> auto-expire, or break-glass (self-activated, flagged).
// Every action is audit-logged. The PermissionGuard consults active grants on a
// permission miss (see hasActiveGrant equivalent in the guard).
// =============================================================================

import { holdersOf } from "../common/approvers";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { NON_STAFF_ROLE_NAMES, SECURITY_PERMISSIONS, isElevatable, type AuditLogPageDto } from "@sms/types";
import { generateSecret, otpauthUri, verifyTotp } from "../auth/totp";
import { signStepUp } from "../auth/stepup";
import { decodeAuditCursor, encodeAuditCursor } from "../common/audit-cursor";
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
// A HANDOVER covers absence — a trip, a term of leave — so it is measured in days
// rather than the hours a requested elevation lasts. Still bounded: an unbounded
// handover is a role change nobody remembered to review.
const MAX_DELEGATION_HOURS = 24 * 60; // 60 days
const DEFAULT_DELEGATION_HOURS = 24 * 7; // a week of cover

export interface AuditFilter {
  actorId?: string;
  action?: string;
  entity?: string;
  from?: string;
  to?: string;
  limit?: number;
  /** Keyset cursor: the id of the last row of the previous page. */
  cursor?: string;
}
export interface ElevationRequestInput {
  permission: string;
  reason: string;
  minutes?: number;
  breakGlass?: boolean;
}

/**
 * The controls that require two different people, and the permission each
 * checker must hold. Named rather than derived: a permission is not
 * self-describing about whether it is one half of a two-person rule, and a
 * guessed list would either miss one or report a permission that is simply
 * scarce.
 */
const TWO_PERSON_CONTROLS: Array<{ label: string; permission: string }> = [
  { label: "Fee discounts and waivers", permission: "fee.approve" },
  { label: "Salary and employment changes", permission: "hr.salary.approve" },
  { label: "Approval requests (leave, grade publishing, exits)", permission: "workflow.review" },
  { label: "Privilege elevation", permission: "security.elevation.approve" },
  { label: "Role changes touching the junior-admin tier", permission: "rbac.manage" },
];

@Injectable()
export class SecurityService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  // --- audit viewer (keyset-paginated) ---------------------------------------
  async listAudit(p: Principal, f: AuditFilter): Promise<AuditLogPageDto> {
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
      const pageSize = Math.min(Math.max(f.limit ?? 50, 1), 200);
      // audit_log is partitioned on createdAt, so its key — and therefore any
      // Prisma cursor — is the COMPOSITE (id, createdAt). The token stays opaque.
      const cursor = decodeAuditCursor(f.cursor);
      const rows = await tx.auditLog.findMany({
        where,
        // Stable keyset order (createdAt can tie; id breaks ties deterministically).
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageSize,
        ...(cursor ? { cursor: { id_createdAt: cursor }, skip: 1 } : {}),
      });
      const actorIds = [...new Set(rows.map((r: { actorId: string }) => r.actorId))];
      const users = await tx.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      });
      const name = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));
      const entries = rows.map((r) => ({
        id: r.id,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        actorName: name.get(r.actorId) ?? "system",
        createdAt: r.createdAt,
      }));
      // A full page implies there may be more — hand back the last row's key.
      const nextCursor = rows.length === pageSize ? encodeAuditCursor(rows[rows.length - 1]) : null;
      return { entries, nextCursor };
    });
  }

  // --- elevation -------------------------------------------------------------
  async requestElevation(p: Principal, input: ElevationRequestInput) {
    if (!input.permission || !input.reason) {
      throw new BadRequestException("permission and reason are required");
    }
    // SECURITY: platform/cross-tenant, role-assignment, and maker-checker
    // permissions can NEVER be self-elevated (incl. break-glass). They must come
    // from a durable, separate identity. See NON_ELEVATABLE_PERMISSIONS.
    if (!isElevatable(input.permission)) {
      throw new ForbiddenException(`"${input.permission}" cannot be granted via elevation`);
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

  /**
   * HAND OVER a duty: a senior who already holds `permission` lends it to a
   * colleague for a bounded window, without waiting to be asked.
   *
   * The requested path (requestElevation) is bottom-up and needs a DIFFERENT
   * approver. This is top-down and needs a different RECIPIENT — the same
   * protection pointed the other way. What makes it safe is one check that must
   * never be removed: THE GRANTER MUST ALREADY HOLD THE PERMISSION. Nobody can
   * hand over what they do not have, so a handover moves authority sideways and
   * can never manufacture it.
   *
   * `isElevatable` still applies, so the maker-checker authorities — fee.approve,
   * hr.salary.approve, rbac.manage, security.elevation.approve — cannot be lent by
   * anyone, to anyone, for any length of time. Lending the "checker" half of a
   * maker-checker rule does not delegate a duty; it removes the second pair of eyes.
   */
  async delegateElevation(
    p: Principal,
    input: { userId: string; permission: string; reason: string; hours?: number },
  ) {
    const permission = input.permission?.trim();
    const reason = input.reason?.trim();
    if (!permission || !reason) throw new BadRequestException("permission and reason are required");
    if (!isElevatable(permission)) {
      throw new ForbiddenException(`"${permission}" cannot be delegated`);
    }
    // THE check. Without it a school_admin could hand out authority they were never
    // given, and "delegation" would become a way to mint permissions.
    if (!p.permissions.includes(permission)) {
      throw new ForbiddenException(`You cannot hand over "${permission}" — you do not hold it yourself`);
    }
    if (input.userId === p.userId) {
      throw new BadRequestException("A duty is handed to someone else. To raise your own, use break-glass.");
    }
    const hours = Math.floor(input.hours ?? DEFAULT_DELEGATION_HOURS);
    if (!Number.isFinite(hours) || hours < 1 || hours > MAX_DELEGATION_HOURS) {
      throw new BadRequestException(`Choose between 1 and ${MAX_DELEGATION_HOURS} hours`);
    }
    const expiresAt = new Date(Date.now() + hours * 3_600_000);

    return this.db.runAsTenant(this.ctx(p), async (tx) => {
      // RLS confines this to the granter's own school, so someone in another
      // tenant is simply not found — 404, never a cross-tenant disclosure.
      const target = await tx.user.findFirst({ where: { id: input.userId }, select: { id: true, name: true } });
      if (!target) throw new NotFoundException("Colleague not found");

      const grant = await tx.privilegeGrant.create({
        data: {
          schoolId: p.schoolId,
          userId: input.userId,
          permission,
          reason,
          // ACTIVE at once, and legitimately: the second-pair-of-eyes requirement
          // is satisfied by the granter and the grantee being different people.
          status: "ACTIVE",
          delegated: true,
          breakGlass: false,
          requestedById: p.userId,
          approvedById: p.userId,
          expiresAt,
        },
      });
      await this.log(tx, p, "security.elevation.delegate", grant.id, {
        permission,
        to: target.name,
        toUserId: input.userId,
        hours,
        reason,
      });
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
      // A RECERTIFICATION IS ABOUT ACCESS WORTH REVIEWING.
      //
      // This listed every account in the school. Measured on a 900-pupil school
      // that was 977 assignments, 901 of them a pupil holding `student` — the
      // one role that grants the least — in a 128kb payload that grows with the
      // roll. Two things wrong with that, and the second is the serious one:
      // it is slow, and it buries the fifteen staff accounts a reviewer is
      // actually there to check under nine hundred identical rows. A control
      // that has to be scrolled past is a control that gets rubber-stamped.
      //
      // So: an account is listed when it holds ANY role beyond the non-staff
      // baseline. A pupil who has ALSO been given a staff role still appears —
      // that is exactly the grant this report exists to surface — while a pupil
      // who is only a pupil has nothing to recertify. The excluded count is
      // RETURNED rather than dropped, so the page can say what it left out
      // instead of quietly showing a shorter list.
      const all = [...byUser.values()];
      const assignments = all.filter((u) => u.roles.some((r) => !NON_STAFF_ROLE_NAMES.includes(r as never)));
      return {
        roles: (roles as Array<{ name: string; permissions: { permission: { key: string } }[] }>).map((r) => ({
          name: r.name,
          permissions: r.permissions.map((rp) => rp.permission.key).sort(),
        })),
        assignments: assignments.sort((a, b) => a.name.localeCompare(b.name)),
        baselineAccountsExcluded: all.length - assignments.length,
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
      // Sign-in trouble over the same window. One query for both signals: a
      // lockout IS a failed attempt, so counting them separately would need two
      // passes over the same rows.
      const authFailures = await tx.auditLog.findMany({
        where: { action: { in: ["auth.login.failed", "auth.account.locked"] }, createdAt: { gte: since } },
        select: { actorId: true, action: true },
      });
      const failCounts = new Map<string, { count: number; locked: boolean }>();
      for (const r of authFailures as Array<{ actorId: string; action: string }>) {
        const cur = failCounts.get(r.actorId) ?? { count: 0, locked: false };
        cur.count += 1;
        if (r.action === "auth.account.locked") cur.locked = true;
        failCounts.set(r.actorId, cur);
      }
      // Resolve names in ONE query alongside the medical readers, rather than a
      // second round trip — these lists overlap in a small school.
      const failUsers = await tx.user.findMany({
        where: { id: { in: [...failCounts.keys()] } },
        select: { id: true, name: true },
      });
      const failName = new Map(failUsers.map((u: { id: string; name: string }) => [u.id, u.name]));
      const topFailedLogins = [...failCounts.entries()]
        .map(([id, v]) => ({ actorName: failName.get(id) ?? "?", count: v.count, locked: v.locked }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      // TWO-PERSON RULES THAT CANNOT COMPLETE.
      //
      // Every other signal here is BEHAVIOURAL — who used break-glass, who read
      // a lot of medical records, who could not sign in. This one is
      // STRUCTURAL, and it is the only one that reports a control which is not
      // working rather than a person who might bear watching.
      //
      // A maker-checker rule needs two holders of the permission: one to raise
      // and a different one to decide. With ONE, the request can be raised and
      // decided by nobody. With NONE it cannot be decided at all. Neither state
      // announces itself — a school that never appointed a school_admin, or
      // deactivated one of two, simply finds that approvals stop.
      const thin = await Promise.all(
        TWO_PERSON_CONTROLS.map(async (c) => ({
          ...c,
          holders: (await holdersOf(tx, c.permission)).length,
        })),
      );
      return {
        breakGlassCount: breakGlass.length,
        breakGlassEvents: breakGlass,
        topMedicalReaders,
        lockedOutCount: [...failCounts.values()].filter((v) => v.locked).length,
        topFailedLogins,
        // Only the broken ones. A list that also reports what is fine is a list
        // whose length means nothing.
        unstaffedControls: thin.filter((c) => c.holders < 2),
      };
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
