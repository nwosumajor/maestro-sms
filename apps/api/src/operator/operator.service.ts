// =============================================================================
// OperatorService — platform (super_admin) cross-tenant console + impersonation
// =============================================================================
// Only reachable with platform.operate (super_admin). Tenant counts are read by
// setting the RLS GUC to each school in turn (the server controls the GUC — never
// the client). Impersonation mints a short-lived token carrying the TARGET user's
// claims plus an `imp.by` field, and is loudly audit-logged. The minted token is
// the same HS256 shape the web BFF issues, so the API accepts it as a Bearer.
// =============================================================================

import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { Prisma } from "@sms/db";
import {
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_STATUS,
  isModuleKey,
  isPlan,
  isSubscriptionStatus,
  type ModuleOverrides,
  type OperatorBillingAlertDto,
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
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { ModuleEntitlementService } from "../foundation/module-entitlement.service";

const IMPERSONATION_TTL = 900; // 15 min

@Injectable()
export class OperatorService {
  private readonly logger = new Logger("Operator");

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly entitlements: ModuleEntitlementService,
    private readonly privileged: PrivilegedDatabaseService,
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
  async listTenants(
    p: Principal,
    f: { q?: string; plan?: string; billing?: string; page?: number; pageSize?: number } = {},
  ) {
    // Server-side search/filter/PAGINATION: at 500+ schools the old
    // list-everything shape was unusable AND ran 2 enrichment queries per
    // school per view. The where pushes q/plan/billing into SQL; enrichment
    // (user count + entitlement resolve) now costs pageSize, not fleet-size.
    const page = Math.max(1, Math.floor(f.page ?? 1));
    const pageSize = Math.min(Math.max(Math.floor(f.pageSize ?? 10), 1), 50);
    const sub: Record<string, string> = {};
    if (f.plan) sub.plan = f.plan;
    if (f.billing) sub.status = f.billing;
    const where = {
      isPlatform: false,
      ...(f.q
        ? {
            OR: [
              { name: { contains: f.q, mode: "insensitive" as const } },
              { slug: { contains: f.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(Object.keys(sub).length ? { subscription: { is: sub } } : {}),
    };
    // The subscription relation is TENANT-scoped: under the operator's own GUC,
    // RLS hides every other school's subscription row, so an app-role relation
    // filter silently matches nothing. Cross-tenant registry queries therefore
    // run on the PRIVILEGED client (like the analytics/audit consoles); without
    // it, the plain list still works but plan/billing filters 503.
    const client = this.privileged.client;
    if (Object.keys(sub).length > 0 && !client) {
      throw new ServiceUnavailableException("Plan/billing filters require the privileged database configuration");
    }
    const query = {
      where,
      select: { id: true, name: true, slug: true, status: true, createdAt: true },
      orderBy: { name: "asc" as const },
      skip: (page - 1) * pageSize,
      take: pageSize,
    };
    const { schools, total } = client
      ? { total: await client.school.count({ where }), schools: await client.school.findMany(query) }
      : await this.db.runAsTenant(this.ctx(p), async (tx) => ({
          total: await tx.school.count({ where }),
          schools: await tx.school.findMany(query),
        }));
    const out = [];
    for (const s of schools as Array<{ id: string; name: string; slug: string; status: string; createdAt: Date }>) {
      const users = await this.db.runAsTenant({ schoolId: s.id, userId: p.userId }, (tx) => tx.user.count());
      const ent = await this.entitlements.resolve(s.id);
      out.push({ ...s, users, plan: ent.plan, moduleCount: ent.modules.length, subscriptionStatus: ent.status });
    }
    return { tenants: out, total, page, pageSize };
  }

  /** Lightweight id+name list for pickers (single query; no per-school work). */
  async listTenantNames(p: Principal) {
    return this.db.runAsTenant(this.ctx(p), (tx) =>
      tx.school.findMany({ where: { isPlatform: false }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    );
  }

  /** Enable/disable a SCHOOL (the hard deactivation lever). DISABLED blocks
   *  every member login (checked in AuthService after password verification) and
   *  hides the school from the public directory; nothing is deleted, so
   *  re-enabling restores everything instantly. The school registry is global —
   *  the app role is SELECT-only on it, so the write uses the PRIVILEGED client
   *  (503 when unconfigured, like provisioning). Audited. */
  async setSchoolStatus(p: Principal, schoolId: string, status: "ACTIVE" | "DISABLED") {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("School administration requires the privileged database configuration");
    const school = await client.school.findFirst({ where: { id: schoolId, isPlatform: false }, select: { id: true, name: true } });
    if (!school) throw new NotFoundException("School not found");
    await client.school.update({ where: { id: schoolId }, data: { status } });
    await this.db.runAsTenant(this.ctx(p), (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "operator.school.status",
          entity: "school",
          entityId: schoolId,
          schoolId: p.schoolId,
          metadata: { targetSchoolId: schoolId, name: school.name, status },
        },
        tx,
      ),
    );
    return { id: schoolId, status };
  }

  /** Every tenant currently past its paid period — feeds the operator console's
   *  red billing banner. Subscription rows are tenant-scoped, so this runs on
   *  the PRIVILEGED client (like the registry); [] without a privileged URL. */
  async listBillingAlerts(): Promise<OperatorBillingAlertDto[]> {
    const client = this.privileged.client;
    if (!client) return [];
    const now = new Date();
    const lapsed = await client.schoolSubscription.findMany({
      where: { status: SUBSCRIPTION_STATUS.PAST_DUE },
      select: { schoolId: true, plan: true, currentPeriodEnd: true },
    });
    if (lapsed.length === 0) return [];
    const schools = await client.school.findMany({
      where: { id: { in: lapsed.map((s) => s.schoolId) }, isPlatform: false },
      select: { id: true, name: true, slug: true },
    });
    const byId = new Map(schools.map((s) => [s.id, s]));
    return lapsed
      .flatMap((s) => {
        const school = byId.get(s.schoolId);
        if (!school) return [];
        const end = s.currentPeriodEnd ? new Date(s.currentPeriodEnd) : null;
        const daysPastDue = end ? Math.max(0, Math.floor((now.getTime() - end.getTime()) / 86_400_000)) : 0;
        return [
          {
            schoolId: s.schoolId,
            name: school.name,
            slug: school.slug,
            plan: s.plan,
            currentPeriodEnd: s.currentPeriodEnd,
            daysPastDue,
            downgraded: daysPastDue > SUBSCRIPTION_GRACE_DAYS,
          },
        ];
      })
      .sort((a, b) => b.daysPastDue - a.daysPastDue);
  }

  /** Every enrolled student of a given school (cross-tenant; the operator sets the
   *  GUC to the target school, then RLS scopes the reads). Audited — student PII on
   *  minors (Golden Rule #5). */
  async listSchoolStudents(p: Principal, schoolId: string) {
    const result = await this.db.runAsTenant({ schoolId, userId: p.userId }, async (tx) => {
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException("School not found");
      // By ROLE, not by enrollment — enrollment-derived listing hid every
      // not-yet-enrolled student from the operator (while the school's own
      // /students page, already role-based, showed them). One platform-wide
      // definition of "student"; active-class names are attached where present.
      const students = await tx.user.findMany({
        where: { roles: { some: { role: { name: "student" } } } },
        select: { id: true, uniqueId: true, name: true, email: true },
        orderBy: { name: "asc" },
      });
      const ids = students.map((st) => st.id);
      const enrollments = ids.length
        ? await tx.enrollment.findMany({
            where: { status: "ACTIVE", studentId: { in: ids } },
            include: { class: { select: { name: true } } },
          })
        : [];
      const classesBy = new Map<string, string[]>();
      for (const e of enrollments as Array<{ studentId: string; class: { name: string } }>) {
        const arr = classesBy.get(e.studentId);
        if (arr) arr.push(e.class.name);
        else classesBy.set(e.studentId, [e.class.name]);
      }
      const profiles = ids.length
        ? await tx.studentProfile.findMany({ where: { studentId: { in: ids } }, select: { studentId: true, admissionNumber: true } })
        : [];
      const admNo = new Map(profiles.map((pr: { studentId: string; admissionNumber: string | null }) => [pr.studentId, pr.admissionNumber]));
      return students.map((st) => ({
        ...st,
        classes: classesBy.get(st.id) ?? [],
        admissionNumber: admNo.get(st.id) ?? null,
      }));
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
      const school = await tx.school.findFirst({ where: { id: schoolId }, select: { name: true } });
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
      return { name: u.name, schoolName: school?.name ?? "", roles, permissions };
    });

    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new NotFoundException("Auth not configured");
    // The target school's effective modules — the web nav is module-gated, so an
    // impersonated session without them renders an empty app.
    const modules = await this.entitlements.effectiveModules(schoolId);
    const token = jwt.sign(
      {
        userId,
        school_id: schoolId,
        roles: target.roles,
        permissions: target.permissions,
        // Everything the web session needs rides INSIDE the signed token: the
        // browser must not be able to hand itself a different school or module set.
        // (The API ignores these; it re-derives entitlements server-side anyway.)
        name: target.name,
        schoolName: target.schoolName,
        modules,
        imp: { by: p.userId },
      },
      secret,
      { algorithm: "HS256", expiresIn: IMPERSONATION_TTL },
    );

    // Audit in the OPERATOR's own tenant (actor FK is the operator).
    await this.auditAsOperator(p, { actorId: p.userId, action: "operator.impersonate", entity: "user", entityId: userId, schoolId: p.schoolId, metadata: { targetSchoolId: schoolId, targetName: target.name } });
    return { token, expiresIn: IMPERSONATION_TTL, target: { userId, name: target.name, roles: target.roles } };
  }
}
