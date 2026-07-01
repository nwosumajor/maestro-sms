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

import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { ModuleKey, ModuleOverrides, PlatformAnalyticsDto, Plan, SubscriptionStatus } from "@sms/types";
import {
  DEFAULT_PLAN,
  MODULE_CATALOG,
  PLAN_PRICING,
  SUBSCRIPTION_STATUS,
  ageBand,
  effectivePlan,
  isPlan,
  normalizeGender,
  resolveModules,
} from "@sms/types";
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
  private readonly logger = new Logger("PlatformAnalytics");

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
      select: { id: true, name: true, status: true, createdAt: true },
    });
    const schoolName = new Map(schools.map((s) => [s.id, s.name]));
    const customerIds = schools.map((s) => s.id);
    const schoolStatus = { total: schools.length, active: 0, disabled: 0 };
    for (const s of schools) {
      if (s.status === "ACTIVE") schoolStatus.active++;
      else schoolStatus.disabled++;
    }

    // --- subscriptions (drives plan mix, MRR, module adoption, risk) ---
    const subs = await client.schoolSubscription.findMany({
      where: { schoolId: { in: customerIds } },
      select: { schoolId: true, plan: true, status: true, currentPeriodEnd: true, seats: true, overrides: true },
    });
    const subBySchool = new Map(subs.map((s) => [s.schoolId, s]));

    // --- people (students + staff), plus students-per-school for MRR seats + top schools ---
    const roleRows = await client.userRole.findMany({
      where: { schoolId: { in: customerIds } },
      select: { userId: true, schoolId: true, role: { select: { name: true } } },
    });
    const studentUsers = new Set<string>();
    const staffUsers = new Set<string>();
    const studentsBySchool = new Map<string, number>();
    for (const r of roleRows) {
      if (r.role.name === "student") {
        studentUsers.add(r.userId);
        studentsBySchool.set(r.schoolId, (studentsBySchool.get(r.schoolId) ?? 0) + 1);
      } else if (STAFF_ROLES.has(r.role.name)) {
        staffUsers.add(r.userId);
      }
    }
    const studentCreatedAt = studentUsers.size
      ? await client.user.findMany({ where: { id: { in: [...studentUsers] } }, select: { createdAt: true } })
      : [];

    // --- per-school roll-up: effective plan, seats, MRR, effective modules ---
    const perSeatMonthly = (plan: Plan): number => PLAN_PRICING[plan]?.perSeatMonthlyMinor ?? 0;
    const schoolsByPlan: Record<string, number> = {};
    const schoolsByStatus: Record<string, number> = {};
    const mrrByPlan: Record<string, number> = {};
    const moduleCount = new Map<ModuleKey, number>();
    let mrrTotalMinor = 0;
    let payingSchools = 0;
    let pastDue = 0;
    let canceled = 0;
    let atRiskMrrMinor = 0;
    let modulesSum = 0;
    const perSchool = schools.map((s) => {
      const sub = subBySchool.get(s.id);
      const students = studentsBySchool.get(s.id) ?? 0;
      const purchased = (sub && isPlan(sub.plan) ? sub.plan : DEFAULT_PLAN) as Plan;
      const status = (sub?.status ?? SUBSCRIPTION_STATUS.ACTIVE) as SubscriptionStatus;
      const effective = sub
        ? effectivePlan(purchased, status, sub.currentPeriodEnd)
        : DEFAULT_PLAN;
      const seats = sub?.seats && sub.seats > 0 ? sub.seats : students;
      const monthly = perSeatMonthly(effective) * seats;
      const modules = resolveModules(effective, (sub?.overrides as unknown as ModuleOverrides) ?? null);

      schoolsByPlan[effective] = (schoolsByPlan[effective] ?? 0) + 1;
      schoolsByStatus[status] = (schoolsByStatus[status] ?? 0) + 1;
      modulesSum += modules.length;
      for (const m of modules) moduleCount.set(m, (moduleCount.get(m) ?? 0) + 1);

      if (status === SUBSCRIPTION_STATUS.ACTIVE && sub) {
        mrrTotalMinor += monthly;
        mrrByPlan[effective] = (mrrByPlan[effective] ?? 0) + monthly;
        payingSchools += 1;
      } else if (status === SUBSCRIPTION_STATUS.PAST_DUE) {
        pastDue += 1;
        atRiskMrrMinor += monthly;
      } else if (status === SUBSCRIPTION_STATUS.CANCELED) {
        canceled += 1;
      }
      return { name: s.name, students, plan: effective, mrrMinor: monthly };
    });

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
    const onboarding = await client.onboardingRequest.groupBy({ by: ["status"], _count: { _all: true } });
    const onboardingPipeline: Record<string, number> = {};
    for (const o of onboarding as Array<{ status: string; _count: { _all: number } }>) {
      onboardingPipeline[o.status] = o._count._all;
    }

    // --- 6-month growth + revenue trend ---
    const now = new Date();
    const buckets: { key: string; month: string; schools: number; students: number; revenueMinor: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        month: d.toLocaleString("en-US", { month: "short" }),
        schools: 0,
        students: 0,
        revenueMinor: 0,
      });
    }
    const bucketOf = new Map(buckets.map((b, i) => [b.key, i]));
    const keyFor = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    for (const s of schools) {
      const i = bucketOf.get(keyFor(s.createdAt));
      if (i !== undefined) buckets[i].schools += 1;
    }
    for (const u of studentCreatedAt) {
      const i = bucketOf.get(keyFor(u.createdAt));
      if (i !== undefined) buckets[i].students += 1;
    }
    for (const pay of payments) {
      const i = bucketOf.get(keyFor(pay.createdAt));
      if (i !== undefined) buckets[i].revenueMinor += pay.amountMinor;
    }

    // --- platform-wide student demographics (from profiles across all schools) ---
    const profiles = await client.studentProfile.findMany({
      where: { schoolId: { in: customerIds } },
      select: { gender: true, dateOfBirth: true },
    });
    const genderMix: Record<string, number> = {};
    const ageMix: Record<string, number> = {};
    for (const pr of profiles) {
      const g = normalizeGender(pr.gender);
      genderMix[g] = (genderMix[g] ?? 0) + 1;
      const b = ageBand(pr.dateOfBirth);
      ageMix[b] = (ageMix[b] ?? 0) + 1;
    }

    const moduleLabel = new Map(MODULE_CATALOG.map((m) => [m.key, m.label]));
    const moduleAdoption = [...moduleCount.entries()]
      .map(([key, n]) => ({ key, label: moduleLabel.get(key) ?? key, schools: n }))
      .sort((a, b) => b.schools - a.schools);
    const topSchools = perSchool.sort((a, b) => b.students - a.students).slice(0, 6);

    return {
      schools: schoolStatus,
      schoolsByPlan,
      schoolsByStatus,
      people: { students: studentUsers.size, staff: staffUsers.size },
      revenue: { paidTotalMinor, payments: payments.length, last30dMinor },
      onboardingPipeline,
      recentPayments,
      mrr: {
        totalMinor: mrrTotalMinor,
        byPlan: mrrByPlan,
        arpaMinor: payingSchools ? Math.round(mrrTotalMinor / payingSchools) : 0,
        payingSchools,
      },
      growth: buckets.map(({ month, schools: sc, students: st, revenueMinor }) => ({ month, schools: sc, students: st, revenueMinor })),
      funnel: {
        requests: Object.values(onboardingPipeline).reduce((a, b) => a + b, 0),
        approved: onboardingPipeline.APPROVED ?? 0,
        provisioned: schools.length,
        paying: payingSchools,
      },
      risk: { pastDue, canceled, atRiskMrrMinor },
      moduleAdoption,
      topSchools,
      averages: {
        studentsPerSchool: schools.length ? Math.round(studentUsers.size / schools.length) : 0,
        modulesPerSchool: schools.length ? Math.round(modulesSum / schools.length) : 0,
      },
      demographics: { profiled: profiles.length, gender: genderMix, ageBand: ageMix },
    };
  }

  /** Audit the cross-tenant read under the operator's own (platform-org) tenant.
   *  Best-effort: this is a READ (a "viewed" log), so a logging failure (e.g. a
   *  stale session whose school no longer exists) must NOT fail the dashboard. */
  async auditView(p: Principal): Promise<void> {
    try {
      await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
        this.audit.record(
          { actorId: p.userId, action: "operator.analytics.view", entity: "platform", entityId: "platform", schoolId: p.schoolId, metadata: {} },
          tx,
        ),
      );
    } catch (err) {
      this.logger.warn(`operator.analytics.view audit failed (non-fatal): ${String(err)}`);
    }
  }
}
