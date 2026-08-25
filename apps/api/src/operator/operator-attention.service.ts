// =============================================================================
// OperatorAttentionService — the schools that need a DECISION
// =============================================================================
// The operator console could tell you what exists. It could not tell you what
// changed, and at 5,000 schools those are entirely different products: nobody
// reviews five thousand rows by scrolling, so a dashboard that only renders
// everything accurately is still a dashboard nobody can act on.
//
// This inverts it. Instead of the owner hunting for problems, the system names
// them: six conditions, each one something a person has to decide about, each with
// the number behind it and a severity that says how late it already is.
//
// COST: a fixed handful of grouped queries for the WHOLE fleet — never one per
// school. Every "is this school in trouble" question is answered by asking Postgres
// for the schools that ARE, not by asking every school in turn.
//
// SECURITY: aggregates and registry facts only. School names, counts, money — never
// a pupil, never a staff member, never a record. Reaching an actual person still
// requires impersonation, which is step-up gated and audited by name.
// =============================================================================

import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
// VALUE import: Prisma.sql/join only resolve as values, not types (CLAUDE.md).
import { Prisma } from "@sms/db";
import {
  DEFAULT_PLAN,
  PLAN_PRICING,
  PLATFORM_HOME_CURRENCY,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_STATUS,
  effectivePlan,
  formatMoney,
  isPlan,
  type AttentionKind,
  type AttentionQueueDto,
  type AttentionRowDto,
  type AttentionSignalDto,
  type Plan,
  type SubscriptionStatus,
} from "@sms/types";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { headcountBySchool } from "./operator-people";
import { toMinor } from "../common/money";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";

const DAY_MS = 24 * 60 * 60 * 1000;
/** No audited activity in this many days ⇒ nobody is using the product. */
const DORMANT_DAYS = 14;
/** Registers stopped: a school with pupils that has taken none this long. */
const REGISTER_SILENCE_DAYS = 14;
/** A trial/period ending within this window is worth a conversation now. */
const TRIAL_WARN_DAYS = 14;
/** Rows returned. The queue is for deciding, not browsing; `total` states the rest. */
const QUEUE_LIMIT = 100;

@Injectable()
export class OperatorAttentionService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  async queue(p: Principal): Promise<AttentionQueueDto> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("The attention queue is not configured");

    const now = new Date();
    const schools = await client.school.findMany({
      where: { isPlatform: false, status: "ACTIVE" },
      select: { id: true, name: true },
    });
    if (schools.length === 0) {
      return { rows: [], total: 0, shown: 0, scanned: 0, byKind: {} };
    }
    const ids = schools.map((s) => s.id);

    const [subs, headcounts, activeIds, registerIds, adminCounts] = await Promise.all([
      client.schoolSubscription.findMany({
        where: { schoolId: { in: ids } },
        select: {
          schoolId: true,
          plan: true,
          status: true,
          currentPeriodEnd: true,
          graceDays: true,
          seats: true,
          seatArrearsMinor: true,
          // Which money the arrears are IN. Not decoration: the collection paths
          // refuse cross-currency arithmetic, so arrears in a currency the
          // school no longer renews in are collected by NOTHING.
          currency: true,
        },
      }),
      headcountBySchool(client, ids),
      // Which schools have ANY audited activity recently. Asking the positive
      // question keeps the scan inside the recent audit-log partitions; asking
      // "when did each school last do something" would touch every partition.
      this.recentSchoolIds(
        client,
        Prisma.sql`SELECT DISTINCT "schoolId" FROM audit_log
                   WHERE "createdAt" > ${new Date(now.getTime() - DORMANT_DAYS * DAY_MS)}`,
      ),
      this.recentSchoolIds(
        client,
        Prisma.sql`SELECT DISTINCT "schoolId" FROM attendance_session
                   WHERE date > ${new Date(now.getTime() - REGISTER_SILENCE_DAYS * DAY_MS)}`,
      ),
      // One grouped count of managing accounts per school.
      client.$queryRaw<Array<{ schoolId: string; admins: number }>>(Prisma.sql`
        SELECT ur."schoolId", count(DISTINCT ur."userId")::int AS admins
        FROM user_role ur
        JOIN role r ON r.id = ur."roleId"
        WHERE r.name IN ('school_admin', 'principal')
          AND ur."schoolId" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
        GROUP BY ur."schoolId"
      `),
    ]);

    const subBy = new Map(subs.map((s) => [s.schoolId, s]));
    const adminBy = new Map(adminCounts.map((a) => [a.schoolId, a.admins]));
    const byKind: Record<string, number> = {};
    const rows: AttentionRowDto[] = [];

    for (const s of schools) {
      const sub = subBy.get(s.id);
      const head = headcounts.get(s.id) ?? { students: 0, staff: 0, parents: 0 };
      const purchased = (sub && isPlan(sub.plan) ? sub.plan : DEFAULT_PLAN) as Plan;
      const status = (sub?.status ?? SUBSCRIPTION_STATUS.ACTIVE) as SubscriptionStatus;
      const effective = sub
        ? effectivePlan(purchased, status, sub.currentPeriodEnd, sub.graceDays ?? undefined)
        : DEFAULT_PLAN;
      const seats = sub?.seats && sub.seats > 0 ? sub.seats : head.students;
      const mrrMinor = (PLAN_PRICING[effective]?.perSeatMonthlyMinor ?? 0) * seats;

      const signals: AttentionSignalDto[] = [];
      const add = (kind: AttentionKind, detail: string, severity: 1 | 2 | 3) => {
        signals.push({ kind, detail, severity });
        byKind[kind] = (byKind[kind] ?? 0) + 1;
      };

      // --- money ---------------------------------------------------------------
      if (status === SUBSCRIPTION_STATUS.PAST_DUE) {
        const overdue = sub?.currentPeriodEnd
          ? Math.max(0, Math.floor((now.getTime() - sub.currentPeriodEnd.getTime()) / DAY_MS))
          : 0;
        // Whether the grace window has ELAPSED is the difference between "chase the
        // payment" and "their modules are already gone" — two different phone calls.
        // The console's red banner carried this distinction; the queue now does, so
        // that banner could be reduced to a link without losing anything.
        const grace = sub?.graceDays ?? SUBSCRIPTION_GRACE_DAYS;
        const downgraded = overdue > grace;
        add(
          "PAST_DUE",
          downgraded
            ? `Payment overdue ${overdue} days — already downgraded to Standard`
            : `Payment overdue ${overdue} day${overdue === 1 ? "" : "s"} — still in the ${grace}-day grace window`,
          3,
        );
      } else if (sub?.currentPeriodEnd) {
        const daysLeft = Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / DAY_MS);
        // Never paid + period ending = the trial conversation, and it has a date.
        if (daysLeft >= 0 && daysLeft <= TRIAL_WARN_DAYS && (sub.seats ?? 0) === 0) {
          add("TRIAL_ENDING", `Trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}; never paid`, 2);
        }
      }
      const arrearsMinor = Math.max(0, toMinor(sub?.seatArrearsMinor));
      if (arrearsMinor > 0) {
        // Already computed by the dunning sweep; it was never surfaced anywhere the
        // owner would look, so uncollected growth sat invisible until renewal.
        //
        // AND IT NEVER SAID HOW MUCH. "arrears accruing" is a fact an owner can
        // do nothing with: whether to ring a school about unbilled growth is a
        // decision about an amount, and the amount was the one thing the line
        // left out. It is on the row already.
        const arrearsCurrency = sub?.currency ?? PLATFORM_HOME_CURRENCY;
        add(
          "SEAT_ARREARS",
          `${head.students} pupils against ${sub?.seats ?? 0} billed seats — ` +
            `${formatMoney(arrearsMinor, arrearsCurrency)} metered and not yet billed`,
          2,
        );
      }

      // --- adoption ------------------------------------------------------------
      // `null` = the probe failed, so we do not know; an unknown must not become an
      // accusation (see recentSchoolIds).
      if (activeIds && !activeIds.has(s.id)) {
        add("DORMANT", `No recorded activity in ${DORMANT_DAYS} days`, 3);
      } else if (activeIds && head.students > 0 && registerIds && !registerIds.has(s.id)) {
        // Only meaningful when the school HAS pupils, and only worth saying when the
        // school is otherwise alive — a dormant school obviously takes no registers,
        // and reporting both would be one problem counted twice.
        add("REGISTERS_STOPPED", `No register taken in ${REGISTER_SILENCE_DAYS} days`, 2);
      }

      // --- provisioning --------------------------------------------------------
      if ((adminBy.get(s.id) ?? 0) === 0) {
        add("NO_ADMIN", "No school admin or principal account exists", 3);
      }

      if (signals.length === 0) continue;
      rows.push({
        schoolId: s.id,
        schoolName: s.name,
        plan: effective,
        subscriptionStatus: status,
        students: head.students,
        staff: head.staff,
        mrrMinor,
        severity: Math.max(...signals.map((x) => x.severity)) as 1 | 2 | 3,
        signals,
      });
    }

    // Worst first, then by what is financially at stake — the order somebody would
    // actually work through them in.
    rows.sort((a, b) => b.severity - a.severity || b.mrrMinor - a.mrrMinor || a.schoolName.localeCompare(b.schoolName));
    const shown = rows.slice(0, QUEUE_LIMIT);

    await this.audit.record({
      actorId: p.userId,
      action: "operator.attention.view",
      entity: "platform",
      entityId: "attention",
      schoolId: p.schoolId,
      metadata: { flagged: rows.length, scanned: schools.length },
    });

    return {
      rows: shown,
      total: rows.length,
      shown: shown.length,
      scanned: schools.length,
      // Fleet-wide, not page-wide: a headline counted off the capped page would
      // under-report exactly the way every figure this codebase has had to fix did.
      byKind,
    };
  }

  /**
   * Set of schoolIds returned by a `SELECT DISTINCT "schoolId" …` probe, or NULL
   * if the probe failed.
   *
   * The null matters. These probes drive NEGATIVE signals — a school is dormant
   * because it is ABSENT from the set — so a failed probe returning an empty set
   * would flag every school in the fleet as dormant and bury the real ones. Null
   * means "unknown", and an unknown suppresses the signal entirely: a missed alert
   * is recoverable, five thousand false ones destroy trust in the queue.
   */
  private async recentSchoolIds(
    client: { $queryRaw<T = unknown>(q: Prisma.Sql): Promise<T> },
    sql: Prisma.Sql,
  ): Promise<Set<string> | null> {
    try {
      const rows = await client.$queryRaw<Array<{ schoolId: string }>>(sql);
      return new Set(rows.map((r) => r.schoolId));
    } catch {
      return null;
    }
  }
}
