// =============================================================================
// OperatorService — platform (super_admin) cross-tenant console + impersonation
// =============================================================================
// Only reachable with platform.operate (super_admin). Tenant counts are read by
// setting the RLS GUC to each school in turn (the server controls the GUC — never
// the client). Impersonation mints a short-lived token carrying the TARGET user's
// claims plus an `imp.by` field, and is loudly audit-logged. The minted token is
// the same HS256 shape the web BFF issues, so the API accepts it as a Bearer.
// =============================================================================

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { Prisma } from "@sms/db";
import {
  isModuleKey,
  isPlan,
  isSubscriptionStatus,
  type ModuleOverrides,
  type Plan,
  type SubscriptionDto,
  type SubscriptionStatus,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantContext,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";

const IMPERSONATION_TTL = 900; // 15 min

@Injectable()
export class OperatorService {
  private readonly logger = new Logger("Operator");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly entitlements: ModuleEntitlementService,
  ) {}

  private ctx(p: Principal): TenantContext {
    return { schoolId: p.schoolId, userId: p.userId };
  }

  /** Audit a cross-tenant operator action under the operator's OWN tenant.
   *  Best-effort: the privileged effect is already committed and the action is
   *  captured by the observability request log, so a logging failure (e.g. a stale
   *  session whose school no longer exists) must not 500 a completed operation. */
  private async auditAsOperator(p: Principal, entry: Parameters<AuditLogService["record"]>[0]): Promise<void> {
    try {
      await this.db.runAsTenant(this.ctx(p), (tx) => this.audit.record(entry, tx));
    } catch (err) {
      this.logger.warn(`operator audit '${entry.action}' failed (non-fatal): ${String(err)}`);
    }
  }

  // --- subscription / module entitlements (super_admin, platform.operate) ----
  /** Read a school's subscription + resolved effective modules + billing posture. */
  async getSubscription(p: Principal, schoolId: string): Promise<SubscriptionDto> {
    return this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException("School not found");
      const resolved = await this.entitlements.resolve(schoolId);
      return this.entitlements.dtoFrom(schoolId, resolved);
    });
  }

  /** Set a school's plan + overrides; optionally comp/grant status + period. Audited. */
  async setSubscription(
    p: Principal,
    schoolId: string,
    input: {
      plan: string;
      overrides?: { enabled?: string[]; disabled?: string[] };
      status?: string;
      currentPeriodEnd?: string | Date | null;
    },
  ): Promise<SubscriptionDto> {
    if (!isPlan(input.plan)) throw new BadRequestException("plan must be one of STANDARD, PREMIUM, ULTIMATE, ENTERPRISE");
    const plan: Plan = input.plan;
    const enabled = (input.overrides?.enabled ?? []).filter(isModuleKey);
    const disabled = (input.overrides?.disabled ?? []).filter(isModuleKey);
    const overrides: ModuleOverrides = { enabled, disabled };

    let status: SubscriptionStatus | undefined;
    if (input.status !== undefined) {
      if (!isSubscriptionStatus(input.status)) throw new BadRequestException("invalid status");
      status = input.status;
    }
    const currentPeriodEnd =
      input.currentPeriodEnd === undefined
        ? undefined
        : input.currentPeriodEnd === null
          ? null
          : new Date(input.currentPeriodEnd);

    await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException("School not found");
      const existing = await tx.schoolSubscription.findFirst({ where: { schoolId }, select: { id: true } });
      const data: Prisma.SchoolSubscriptionUncheckedUpdateInput = {
        plan,
        overrides: overrides as unknown as Prisma.InputJsonValue,
        ...(status !== undefined ? { status } : {}),
        ...(currentPeriodEnd !== undefined ? { currentPeriodEnd } : {}),
      };
      if (existing) {
        await tx.schoolSubscription.update({ where: { id: existing.id }, data });
      } else {
        await tx.schoolSubscription.create({
          data: { schoolId, plan, overrides: overrides as unknown as Prisma.InputJsonValue, ...(status !== undefined ? { status } : {}), ...(currentPeriodEnd !== undefined ? { currentPeriodEnd } : {}) },
        });
      }
    });
    // Audit under the OPERATOR's own tenant (a separate tx), mirroring
    // listSchoolStudents / impersonate. The write above runs with the GUC set to
    // the TARGET school, so an audit_log row carrying the operator's own schoolId
    // can't be written there (RLS WITH CHECK would reject it — schoolId ≠ GUC).
    // The affected school is preserved in metadata.targetSchoolId.
    await this.auditAsOperator(p, {
      actorId: p.userId,
      action: "operator.subscription.set",
      entity: "school_subscription",
      entityId: schoolId,
      schoolId: p.schoolId,
      metadata: { targetSchoolId: schoolId, plan, overrides, status, currentPeriodEnd },
    });
    // Drop the cached entitlements so the new posture takes effect immediately.
    this.entitlements.invalidate(schoolId);
    const resolved = await this.entitlements.resolve(schoolId);
    return this.entitlements.dtoFrom(schoolId, resolved);
  }

  /** Every tenant + a user count each. School registry is global/RLS-exempt. */
  async listTenants(p: Principal) {
    const schools = await this.db.runAsTenant(this.ctx(p), (tx) =>
      // Exclude the platform org itself — it's not a customer tenant.
      tx.school.findMany({ where: { isPlatform: false }, select: { id: true, name: true, slug: true, status: true, createdAt: true }, orderBy: { name: "asc" } }),
    );
    const out = [];
    for (const s of schools as Array<{ id: string; name: string; slug: string; status: string; createdAt: Date }>) {
      const users = await this.db.runAsTenant({ schoolId: s.id, userId: p.userId }, (tx) => tx.user.count());
      const ent = await this.entitlements.resolve(s.id);
      out.push({ ...s, users, plan: ent.plan, moduleCount: ent.modules.length, subscriptionStatus: ent.status });
    }
    return out;
  }

  /** Every enrolled student of a given school (cross-tenant; the operator sets the
   *  GUC to the target school, then RLS scopes the reads). Audited — student PII on
   *  minors (Golden Rule #5). */
  async listSchoolStudents(p: Principal, schoolId: string) {
    const result = await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException("School not found");
      const enrollments = await tx.enrollment.findMany({
        where: { status: "ACTIVE" },
        include: { student: { select: { id: true, uniqueId: true, name: true, email: true } }, class: { select: { name: true } } },
      });
      // Group by student → their active class names.
      const byStudent = new Map<string, { id: string; uniqueId: string; name: string; email: string; classes: string[] }>();
      for (const e of enrollments as Array<{ student: { id: string; uniqueId: string; name: string; email: string }; class: { name: string } }>) {
        const cur = byStudent.get(e.student.id) ?? { ...e.student, classes: [] };
        cur.classes.push(e.class.name);
        byStudent.set(e.student.id, cur);
      }
      const ids = [...byStudent.keys()];
      const profiles = ids.length
        ? await tx.studentProfile.findMany({ where: { studentId: { in: ids } }, select: { studentId: true, admissionNumber: true } })
        : [];
      const admNo = new Map(profiles.map((pr: { studentId: string; admissionNumber: string | null }) => [pr.studentId, pr.admissionNumber]));
      return [...byStudent.values()]
        .map((s) => ({ ...s, admissionNumber: admNo.get(s.id) ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
    // Audit the cross-tenant PII view in the operator's own tenant.
    await this.auditAsOperator(p, { actorId: p.userId, action: "operator.students.view", entity: "school", entityId: schoolId, schoolId: p.schoolId, metadata: { targetSchoolId: schoolId, count: result.length } });
    return result;
  }

  /** Mint an audited impersonation token for a user in a (possibly other) tenant. */
  async impersonate(p: Principal, schoolId: string, userId: string) {
    const target = await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const u = await tx.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
      if (!u) throw new NotFoundException("Target user not found");
      const userRoles = await tx.userRole.findMany({
        where: { userId },
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      });
      const roles = (userRoles as Array<{ role: { name: string } }>).map((ur) => ur.role.name);
      const permissions = [
        ...new Set(
          (userRoles as Array<{ role: { permissions: { permission: { key: string } }[] } }>).flatMap((ur) =>
            ur.role.permissions.map((rp) => rp.permission.key),
          ),
        ),
      ];
      return { name: u.name, roles, permissions };
    });

    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new NotFoundException("Auth not configured");
    const token = jwt.sign(
      { userId, school_id: schoolId, roles: target.roles, permissions: target.permissions, imp: { by: p.userId } },
      secret,
      { algorithm: "HS256", expiresIn: IMPERSONATION_TTL },
    );

    // Audit in the OPERATOR's own tenant (actor FK is the operator).
    await this.auditAsOperator(p, { actorId: p.userId, action: "operator.impersonate", entity: "user", entityId: userId, schoolId: p.schoolId, metadata: { targetSchoolId: schoolId, targetName: target.name } });
    return { token, expiresIn: IMPERSONATION_TTL, target: { userId, name: target.name, roles: target.roles } };
  }
}
