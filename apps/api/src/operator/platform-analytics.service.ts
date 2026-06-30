// =============================================================================
// PlatformAnalyticsService — cross-tenant business metrics for the platform owner
// =============================================================================
// The super_admin (platform owner) sells the SMS to schools; this is their
// business dashboard: how many customer schools, on which plans, paying how much.
// It spans EVERY tenant, so it reads through the shared PRIVILEGED client (RLS-
// bypassing, like the operator provisioning / dunning sweeps) rather than a single
// tenant transaction. The platform org itself (isPlatform=true) is excluded from
// every figure — it is not a customer. Read-only + audited at the controller.
// 503-disabled (via the privileged client being null) when no privileged URL.

import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { PlatformAnalyticsDto, Plan, SubscriptionStatus } from "@sms/types";
import { SUBSCRIPTION_STATUS, effectivePlan } from "@sms/types";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const STAFF_ROLES = new Set([
  "school_admin",
  "principal",
  "teacher",
  "accountant",
  "board",
  "hr_clerk",
  "hr_manager",
  "head_teacher",
  "head_admin",
]);
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PlatformAnalyticsService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  async overview(p: Principal): Promise<PlatformAnalyticsDto> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Platform analytics are not configured");

    // --- customer schools (exclude the platform org itself) ---
    const schools = await client.school.findMany({
      where: { isPlatform: false },
      select: { id: true, name: true, status: true },
    });
    const schoolName = new Map(schools.map((s) => [s.id, s.name]));
    const schoolStatus = { total: schools.length, active: 0, disabled: 0 };
    for (const s of schools) {
      if (s.status === "ACTIVE") schoolStatus.active++;
      else schoolStatus.disabled++;
    }

    // --- plan + subscription-status mix (effective plan reflects delinquency) ---
    const subs = await client.schoolSubscription.findMany({
      where: { schoolId: { in: schools.map((s) => s.id) } },
      select: { schoolId: true, plan: true, status: true, currentPeriodEnd: true },
    });
    const schoolsByPlan: Record<string, number> = {};
    const schoolsByStatus: Record<string, number> = {};
    const subBySchool = new Set(subs.map((s) => s.schoolId));
    for (const sub of subs) {
      const effective = effectivePlan(sub.plan as Plan, sub.status as SubscriptionStatus, sub.currentPeriodEnd);
      schoolsByPlan[effective] = (schoolsByPlan[effective] ?? 0) + 1;
      schoolsByStatus[sub.status] = (schoolsByStatus[sub.status] ?? 0) + 1;
    }
    // Schools with no subscription row default to ACTIVE/ENTERPRISE entitlements.
    const noSub = schools.filter((s) => !subBySchool.has(s.id)).length;
    if (noSub > 0) {
      schoolsByPlan.ENTERPRISE = (schoolsByPlan.ENTERPRISE ?? 0) + noSub;
      schoolsByStatus[SUBSCRIPTION_STATUS.ACTIVE] = (schoolsByStatus[SUBSCRIPTION_STATUS.ACTIVE] ?? 0) + noSub;
    }

    // --- people across all customer schools (exclude platform-org members) ---
    const customerIds = schools.map((s) => s.id);
    const roleRows = await client.userRole.findMany({
      where: { schoolId: { in: customerIds } },
      select: { userId: true, role: { select: { name: true } } },
    });
    const studentUsers = new Set<string>();
    const staffUsers = new Set<string>();
    for (const r of roleRows) {
      if (r.role.name === "student") studentUsers.add(r.userId);
      else if (STAFF_ROLES.has(r.role.name)) staffUsers.add(r.userId);
    }

    // --- revenue from PAID platform-subscription payments ---
    const payments = await client.platformSubscriptionPayment.findMany({
      where: { schoolId: { in: customerIds }, status: "PAID" },
      select: { schoolId: true, plan: true, amountMinor: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    const since30 = Date.now() - 30 * DAY_MS;
    let paidTotalMinor = 0;
    let last30dMinor = 0;
    for (const pay of payments) {
      paidTotalMinor += pay.amountMinor;
      if (pay.createdAt.getTime() >= since30) last30dMinor += pay.amountMinor;
    }
    const recentPayments = payments.slice(0, 10).map((pay) => ({
      schoolName: schoolName.get(pay.schoolId) ?? "—",
      plan: pay.plan,
      amountMinor: pay.amountMinor,
      status: pay.status,
      createdAt: pay.createdAt,
    }));

    // --- onboarding intake pipeline (global, RLS-exempt registry table) ---
    const onboarding = await client.onboardingRequest.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const onboardingPipeline: Record<string, number> = {};
    for (const o of onboarding as Array<{ status: string; _count: { _all: number } }>) {
      onboardingPipeline[o.status] = o._count._all;
    }

    return {
      schools: schoolStatus,
      schoolsByPlan,
      schoolsByStatus,
      people: { students: studentUsers.size, staff: staffUsers.size },
      revenue: { paidTotalMinor, payments: payments.length, last30dMinor },
      onboardingPipeline,
      recentPayments,
    };
  }

  /** Audit the cross-tenant read under the operator's own (platform-org) tenant. */
  async auditView(p: Principal): Promise<void> {
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        { actorId: p.userId, action: "operator.analytics.view", entity: "platform", entityId: "platform", schoolId: p.schoolId, metadata: {} },
        tx,
      ),
    );
  }
}
