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
import type {
  GamesAnalyticsDto,
  GamesModeStatDto,
  ModuleKey,
  ModuleOverrides,
  PlatformAnalyticsDto,
  Plan,
  SubscriptionStatus,
} from "@sms/types";
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
      select: { schoolId: true, plan: true, status: true, currentPeriodEnd: true, graceDays: true, seats: true, overrides: true },
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
        ? effectivePlan(purchased, status, sub.currentPeriodEnd, sub.graceDays ?? undefined)
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
  /**
   * Fleet-wide GAMES adoption/engagement. Aggregate and PII-free by design:
   * every figure is a COUNT — no name, handle or per-student row ever crosses
   * the tenant boundary here (Golden Rule #5; the pseudonymous Ultimate arena
   * stays the only cross-school game surface). Reads through the privileged
   * client like the business overview; a couple dozen count/groupBy queries,
   * operator-only and viewed rarely — fine without caching.
   */
  async games(p: Principal): Promise<GamesAnalyticsDto> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Platform analytics are not configured");
    void p;
    const cutoff = new Date(Date.now() - 30 * DAY_MS);

    // --- schools: entitlement + per-school opt-out + recent activity ---------
    const schools = await client.school.findMany({
      where: { isPlatform: false },
      select: { id: true, subscription: { select: { plan: true, status: true, currentPeriodEnd: true, graceDays: true, overrides: true } } },
    });
    let gamesEntitled = 0;
    for (const s of schools) {
      const sub = s.subscription;
      const purchased = sub && isPlan(sub.plan) ? sub.plan : DEFAULT_PLAN;
      const plan = sub
        ? effectivePlan(purchased, sub.status as SubscriptionStatus, sub.currentPeriodEnd, sub.graceDays ?? undefined)
        : DEFAULT_PLAN;
      const overrides = (sub?.overrides as unknown as ModuleOverrides) ?? null;
      if (resolveModules(plan, overrides).includes("games" as ModuleKey)) gamesEntitled += 1;
    }
    const disabledBySetting = await client.gameSettings.count({ where: { gamesEnabled: false } });
    // Distinct schools with ANY game created in the window (all 7 surfaces).
    const activeSchoolRows = await client.$queryRaw<Array<{ c: bigint }>>`
      SELECT COUNT(DISTINCT sid) AS c FROM (
        SELECT "schoolId" AS sid FROM game            WHERE "createdAt" >= ${cutoff}
        UNION SELECT "schoolId" FROM live_quiz_session WHERE "createdAt" >= ${cutoff}
        UNION SELECT "schoolId" FROM typing_race       WHERE "createdAt" >= ${cutoff}
        UNION SELECT "schoolId" FROM hangman_game      WHERE "createdAt" >= ${cutoff}
        UNION SELECT "schoolId" FROM chess_game        WHERE "createdAt" >= ${cutoff}
        UNION SELECT "schoolId" FROM checkers_game     WHERE "createdAt" >= ${cutoff}
      ) AS active_schools`;

    // --- players: distinct ACCOUNTS across every join surface (counts only) --
    const playerCount = async (since?: Date): Promise<number> => {
      const rows = since
        ? await client.$queryRaw<Array<{ c: bigint }>>`
            SELECT COUNT(DISTINCT uid) AS c FROM (
              SELECT gp."userId" AS uid FROM game_player gp WHERE gp."createdAt" >= ${since}
              UNION SELECT tr."userId" FROM typing_racer tr JOIN typing_race t ON t.id = tr."raceId" WHERE t."createdAt" >= ${since}
              UNION SELECT hp."userId" FROM hangman_player hp JOIN hangman_game h ON h.id = hp."gameId" WHERE h."createdAt" >= ${since}
              UNION SELECT qp."userId" FROM live_quiz_participant qp JOIN live_quiz_session s ON s.id = qp."sessionId" WHERE s."createdAt" >= ${since}
              UNION SELECT c."whiteUserId" FROM chess_game c WHERE c."createdAt" >= ${since}
              UNION SELECT c."blackUserId" FROM chess_game c WHERE c."blackUserId" IS NOT NULL AND c."createdAt" >= ${since}
              UNION SELECT k."blackUserId" FROM checkers_game k WHERE k."createdAt" >= ${since}
              UNION SELECT k."whiteUserId" FROM checkers_game k WHERE k."whiteUserId" IS NOT NULL AND k."createdAt" >= ${since}
            ) AS players`
        : await client.$queryRaw<Array<{ c: bigint }>>`
            SELECT COUNT(DISTINCT uid) AS c FROM (
              SELECT "userId" AS uid FROM game_player
              UNION SELECT "userId" FROM typing_racer
              UNION SELECT "userId" FROM hangman_player
              UNION SELECT "userId" FROM live_quiz_participant
              UNION SELECT "whiteUserId" FROM chess_game
              UNION SELECT "blackUserId" FROM chess_game WHERE "blackUserId" IS NOT NULL
              UNION SELECT "blackUserId" FROM checkers_game
              UNION SELECT "whiteUserId" FROM checkers_game WHERE "whiteUserId" IS NOT NULL
            ) AS players`;
      return Number(rows[0]?.c ?? 0);
    };

    // --- per-surface counters: total / ACTIVE now / created in 30d -----------
    const stat = async (
      totalQ: () => Promise<number>,
      activeQ: () => Promise<number>,
      recentQ: () => Promise<number>,
    ): Promise<GamesModeStatDto> => ({ total: await totalQ(), activeNow: await activeQ(), last30d: await recentQ() });

    const guessing: Record<string, GamesModeStatDto> = {};
    for (const mode of ["DUEL", "RING", "RACE", "LEAGUE_MATCH", "KNOCKOUT_MATCH"] as const) {
      guessing[mode] = await stat(
        () => client.game.count({ where: { mode } }),
        () => client.game.count({ where: { mode, status: "ACTIVE" } }),
        () => client.game.count({ where: { mode, createdAt: { gte: cutoff } } }),
      );
    }

    const arcade: Record<string, GamesModeStatDto> = {
      LIVE_QUIZ: await stat(
        () => client.liveQuizSession.count(),
        () => client.liveQuizSession.count({ where: { status: "ACTIVE" } }),
        () => client.liveQuizSession.count({ where: { createdAt: { gte: cutoff } } }),
      ),
      TYPING_RACE: await stat(
        () => client.typingRace.count(),
        () => client.typingRace.count({ where: { status: "ACTIVE" } }),
        () => client.typingRace.count({ where: { createdAt: { gte: cutoff } } }),
      ),
      HANGMAN: await stat(
        () => client.hangmanGame.count(),
        () => client.hangmanGame.count({ where: { status: "ACTIVE" } }),
        () => client.hangmanGame.count({ where: { createdAt: { gte: cutoff } } }),
      ),
      CHESS: await stat(
        () => client.chessGame.count(),
        () => client.chessGame.count({ where: { status: "ACTIVE" } }),
        () => client.chessGame.count({ where: { createdAt: { gte: cutoff } } }),
      ),
      CHECKERS: await stat(
        () => client.checkersGame.count(),
        () => client.checkersGame.count({ where: { status: "ACTIVE" } }),
        () => client.checkersGame.count({ where: { createdAt: { gte: cutoff } } }),
      ),
    };

    const compByType = await client.competition.groupBy({ by: ["type"], _count: { _all: true } });
    const byType: Record<string, number> = {};
    for (const row of compByType) byType[row.type] = row._count._all;
    const competitions = {
      total: await client.competition.count(),
      active: await client.competition.count({ where: { status: "ACTIVE" } }),
      byType,
    };

    const ultimate = {
      competitions: await client.ultimateCompetition.count(),
      active: await client.ultimateCompetition.count({ where: { status: "ACTIVE" } }),
      participants: await client.ultimateParticipant.count(),
      // An enrollment row IS the opt-in (per competition); count distinct schools.
      schoolsEnrolled: (await client.ultimateEnrollment.groupBy({ by: ["schoolId"] })).length,
      consentedStudents: await client.ultimateConsent.count({ where: { granted: true } }),
    };

    return {
      schools: {
        total: schools.length,
        gamesEntitled,
        disabledBySetting,
        activeLast30d: Number(activeSchoolRows[0]?.c ?? 0),
      },
      players: { total: await playerCount(), last30d: await playerCount(cutoff) },
      guessing,
      competitions,
      arcade,
      ultimate,
    };
  }

  async auditGamesView(p: Principal): Promise<void> {
    try {
      await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
        this.audit.record(
          { actorId: p.userId, action: "operator.games.analytics.view", entity: "platform", entityId: "platform", schoolId: p.schoolId, metadata: {} },
          tx,
        ),
      );
    } catch (err) {
      this.logger.warn(`operator.games.analytics.view audit failed (non-fatal): ${String(err)}`);
    }
  }

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
