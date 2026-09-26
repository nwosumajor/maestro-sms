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
  CURRENCIES,
  DEFAULT_PLAN,
  MODULE_CATALOG,
  PLATFORM_HOME_CURRENCY,
  SUBSCRIPTION_STATUS,
  effectivePlan,
  isCurrency,
  isPlan,
  sessionRunRateMinor,
  normalizeGender,
  resolveModules,
} from "@sms/types";
/** The platform bills its own MRR headline in one currency. Anything sold in
 *  another currency is real revenue but belongs on the per-currency ledger, not
 *  added into this figure. */
// One definition, shared with the attention queue beside it.
const HOME_CURRENCY = PLATFORM_HOME_CURRENCY;

/** The age histogram, counted in Postgres. Mirrors the per-school sibling in
 *  `analytics.service.ts` so the two cannot answer differently. */
interface PlatformAgeBandRow {
  unknown: number;
  b0: number; b1: number; b2: number; b3: number; b4: number; b5: number;
}

/** One gender group, carrying its own age bands, so gender and age come from a
 *  single scan of the profiles. */
interface PlatformDemographicRow extends PlatformAgeBandRow {
  gender: string | null;
  n: number;
}

// VALUE import: Prisma.sql/join only resolve as values, not types (CLAUDE.md).
import { Prisma } from "@sms/db";
import { PlanPricingService } from "../billing/plan-pricing.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { SharedCacheService } from "../common/shared-cache.service";
import { ALL_CUSTOMER_SCHOOLS, inSchoolScope } from "./operator-fleet";
import { headcountBySchool } from "./operator-people";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { toMinor } from "../common/money";

const DAY_MS = 24 * 60 * 60 * 1000;

type PrivilegedClient = NonNullable<PrivilegedDatabaseService["client"]>;

/**
 * How long a computed fleet overview is served before it is recomputed.
 *
 * WHY CACHE AT ALL: every computation is three full scans of the fleet's role,
 * user and profile rows (about 3.6 s at 5,000 schools / 2.5M pupils), on the
 * same database the schools' own registers and fee payments use. Without a
 * cache that cost scales with how often platform staff click — five people
 * refreshing a few times is a dozen full scans in a minute. With it, at most
 * one per minute per API process, however many times the page is opened.
 *
 * WHAT IT COSTS, and how each is answered:
 *  - a figure up to a minute old (two, with OVERVIEW_STALE_GRACE_MS) — the
 *    response carries `asOf`, the dashboard prints it, and `fresh` bypasses
 *    the cache (the Refresh button);
 *  - production runs several API tasks, so a copy in PROCESS memory would be a
 *    copy per task: two reloads could disagree, and after Refresh the time
 *    could go BACKWARDS (refresh on one task, reload lands on another still
 *    holding its older copy). The copy therefore lives in REDIS, shared by every
 *    task, and a short lock means one task recomputes while the others wait for
 *    its result. The process-local copy remains only as the FALLBACK for when
 *    Redis is unavailable, which degrades to per-task copies, never to a hang;
 *  - a FAILED computation is never stored, so an error is never served for a
 *    minute.
 */
export const OVERVIEW_CACHE_TTL_MS = 60_000;

/**
 * How long past its minute a copy is still SERVED while the next one is
 * calculated in the background ("stale while revalidating").
 *
 * Without it, whoever opened the dashboard as the minute ran out waited for a
 * full recalculation — about 4 s at 5,000 schools, 2% of opens and the whole of
 * the p99 in the 3-server simulation. With it, that open gets the previous copy
 * at once and ONE task recalculates behind it (under the same Redis lock), so
 * nobody waits on an expiry. The cost is age: a copy can be served up to
 * TTL + grace old (two minutes) to the first open after a quiet minute — which
 * the page states, because it prints `asOf`. Past the grace the copy is gone,
 * so a dashboard nobody has looked at recalculates on demand rather than
 * keeping a stale copy alive, and a background recalculation that keeps
 * failing surfaces as a failure once the grace runs out instead of hiding
 * behind an ever-older copy.
 */
export const OVERVIEW_STALE_GRACE_MS = 60_000;
/** How long a copy is kept at all: its fresh minute plus the grace. */
const OVERVIEW_KEEP_MS = OVERVIEW_CACHE_TTL_MS + OVERVIEW_STALE_GRACE_MS;

/** The shared copy's key. Versioned because the value is a serialised DTO: if
 *  its SHAPE changes, bump this so a new task never reads an old task's shape.
 *  (The TTL bounds any overlap to a minute regardless.) */
export const OVERVIEW_SHARED_KEY = "operator:analytics:overview:v1";
const OVERVIEW_LOCK_KEY = `${OVERVIEW_SHARED_KEY}:lock`;
/** Longest a task may hold the recompute lock. Far above a real computation
 *  (seconds); it only bounds how long a task that DIES mid-computation blocks
 *  the others. */
const OVERVIEW_LOCK_TTL_MS = 30_000;
/** How a task that finds the lock taken waits for the holder's result: polls
 *  counted, not a wall-clock deadline, so a frozen or skewed clock cannot turn
 *  the wait into a spin. 60 x 250 ms = 15 s, then it computes for itself. */
const OVERVIEW_WAIT_POLL_MS = 250;
const OVERVIEW_WAIT_POLLS = 60;

/** Raised for ANY failure talking to the shared cache, so the caller can tell
 *  "Redis is unavailable, use the local copy" from "the computation failed",
 *  which must propagate and must NOT be retried locally. */
class SharedCacheUnavailable extends Error {}

/** A DTO read back from Redis has ISO strings where the type says Date. The
 *  response serialises either way, but code in this process reads `asOf` as a
 *  Date. Every Date field in PlatformAnalyticsDto is revived here, and a test
 *  walks a real computed DTO to fail if one is added without being revived. */
export function reviveOverview(json: string): PlatformAnalyticsDto {
  const v = JSON.parse(json) as PlatformAnalyticsDto;
  v.asOf = new Date(v.asOf);
  for (const r of v.recentPayments) r.createdAt = new Date(r.createdAt);
  return v;
}

@Injectable()
export class PlatformAnalyticsService {
  private readonly logger = new Logger("PlatformAnalytics");

  // SECURITY: ONE copy shared by every operator, which is safe ONLY because the
  // overview is not scoped to the caller — every platform user with the route's
  // permission sees the same fleet-wide figures, and `p` is not read below. If
  // this response is ever narrowed per person (a manager limited to certain
  // schools), key the cache by that scope, or one person's view is served to
  // another.
  // Applies equally to the shared copy in Redis: it is ONE value for every
  // operator on every task.
  /** The process-local copy: the FALLBACK when Redis is unavailable. */
  private cached: { value: PlatformAnalyticsDto; at: number } | null = null;
  /** A request already under way on THIS task, shared by anyone who asks
   *  meanwhile, so two opens on one task make one trip, not two. */
  private inflight: Promise<PlatformAnalyticsDto> | null = null;
  /** A background recalculation started by a stale read on THIS task, so one
   *  task never starts two. (Across tasks, the Redis lock does the same.) */
  private revalidating: Promise<void> | null = null;

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    private readonly planPricing: PlanPricingService,
    private readonly shared: SharedCacheService,
  ) {}

  /**
   * The fleet overview, served from a copy — fresh for OVERVIEW_CACHE_TTL_MS,
   * then served for up to OVERVIEW_STALE_GRACE_MS more while the next copy is
   * calculated in the background, so no ordinary open waits on an expiry.
   * `fresh` recomputes (the dashboard's Refresh button). A computation already
   * running is shared even by a `fresh` request rather than starting a second
   * set of scans: it began at most one computation's length earlier (seconds),
   * and its `asOf` says exactly when.
   *
   * The AUDIT is not here and not skipped: the controller records every view,
   * cached or not, because the log says who looked, not how it was computed.
   */
  async overview(_p: Principal, opts: { fresh?: boolean } = {}): Promise<PlatformAnalyticsDto> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Platform analytics are not configured");
    const fresh = opts.fresh === true;
    // AN ORDINARY OPEN IS SERVED THE CURRENT COPY FIRST, before looking at any
    // computation already running on this task. It used to join whatever was
    // in flight — including somebody else's Refresh — and wait seconds for
    // figures it had not asked for while a perfectly good copy existed.
    // Measured in the 3-server simulation: 50 of 70 slow ordinary opens were
    // exactly that.
    if (!fresh) {
      const current = await this.currentCopy(client);
      if (current) return current;
    }
    if (this.inflight) return this.inflight;
    const run = (async () => {
      if (!this.shared.available) return this.viaLocal(client);
      try {
        return await this.viaShared(client, fresh);
      } catch (e) {
        if (!(e instanceof SharedCacheUnavailable)) throw e; // a failed COMPUTATION propagates
        this.logger.warn(`Shared overview cache unavailable, using this task's copy: ${e.message}`);
        return !fresh && this.ownUsable() ? this.cached!.value : this.viaLocal(client);
      }
    })().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /**
   * The copy an ordinary open should be served, or null when there is none to
   * serve (nothing yet, or older than its grace). Never waits on a computation.
   * With Redis, the shared copy — after publishing this task's own copy if a
   * Redis outage left it NEWER (see viaShared). Without Redis, or if Redis
   * fails here, this task's own copy. A copy past its fresh minute is still
   * served, and starts the next recalculation in the background.
   */
  private async currentCopy(client: PrivilegedClient): Promise<PlatformAnalyticsDto | null> {
    const own = this.ownUsable() ? this.cached!.value : null;
    let chosen: PlatformAnalyticsDto | null = own;
    if (this.shared.available) {
      try {
        const raw = await this.sh(this.shared.get(OVERVIEW_SHARED_KEY));
        const shared = raw ? reviveOverview(raw) : null;
        if (own && (!shared || own.asOf.getTime() > shared.asOf.getTime())) {
          await this.sh(this.shared.set(OVERVIEW_SHARED_KEY, JSON.stringify(own), this.remainingLifeMs(own)));
        } else {
          chosen = shared ? this.remember(shared) : null;
        }
      } catch (e) {
        if (!(e instanceof SharedCacheUnavailable)) throw e;
        chosen = own;
      }
    }
    if (chosen && !this.isFresh(chosen)) this.revalidateInBackground(client);
    return chosen;
  }

  private isFresh(v: PlatformAnalyticsDto): boolean {
    return Date.now() - v.asOf.getTime() < OVERVIEW_CACHE_TTL_MS;
  }

  /**
   * Start the next copy WITHOUT making anyone wait for it. One per task, and
   * across tasks the Redis lock: a task that cannot take it leaves the work to
   * whoever holds it. A failure is logged and never published; the previous
   * copy goes on being served until its grace runs out.
   */
  private revalidateInBackground(client: PrivilegedClient): void {
    if (this.inflight || this.revalidating) return;
    this.revalidating = (async () => {
      try {
        if (!this.shared.available) {
          await this.viaLocal(client);
          return;
        }
        const token = await this.shared.tryLock(OVERVIEW_LOCK_KEY, OVERVIEW_LOCK_TTL_MS);
        if (!token) return; // another task is already recalculating
        try {
          await this.computeAndPublish(client);
        } finally {
          await this.shared.unlock(OVERVIEW_LOCK_KEY, token).catch(() => undefined);
        }
      } catch (e) {
        this.logger.warn(`Background recalculation failed; the previous copy is still served: ${(e as Error).message}`);
      } finally {
        this.revalidating = null;
      }
    })();
  }

  /** This task's own copy is still within its fresh minute or its grace. */
  private ownUsable(): boolean {
    return this.cached !== null && Date.now() - this.cached.at < OVERVIEW_KEEP_MS;
  }

  /** What is left of a copy's life, so republishing it after an outage does
   *  not extend it: it expires in Redis when it would have expired here. */
  private remainingLifeMs(v: PlatformAnalyticsDto): number {
    return Math.max(1, OVERVIEW_KEEP_MS - (Date.now() - v.asOf.getTime()));
  }

  private remember(value: PlatformAnalyticsDto): PlatformAnalyticsDto {
    this.cached = { value, at: value.asOf.getTime() };
    return value;
  }

  /** Redis unavailable: this task's own copy, as the whole platform used to. */
  private async viaLocal(client: PrivilegedClient): Promise<PlatformAnalyticsDto> {
    return this.remember(await this.computeOverview(client));
  }

  /** Any shared-cache call, with its failures made distinguishable. */
  private async sh<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (e) {
      throw new SharedCacheUnavailable((e as Error).message);
    }
  }

  /** Compute, publish to every task, and keep a local copy for a later outage. */
  private async computeAndPublish(client: PrivilegedClient): Promise<PlatformAnalyticsDto> {
    const value = await this.computeOverview(client);
    // A failed WRITE does not waste the computation: this caller still gets it.
    await this.shared.set(OVERVIEW_SHARED_KEY, JSON.stringify(value), OVERVIEW_KEEP_MS).catch(() => undefined);
    return this.remember(value);
  }

  private async viaShared(client: PrivilegedClient, fresh: boolean): Promise<PlatformAnalyticsDto> {
    const raw = await this.sh(this.shared.get(OVERVIEW_SHARED_KEY));
    let previous = raw ? reviveOverview(raw) : null;
    // AFTER A REDIS OUTAGE this task may hold a copy NEWER than the shared one:
    // during the outage it recomputed on its own (a Refresh, or an expiry), and
    // the shared copy still in Redis is from before. Serving the shared one
    // would take anyone who saw this task's figures BACKWARDS, so the newer copy
    // is published instead and every task converges on it. Measured before
    // this: 11 of 49 requests in the ten seconds after Redis returned saw an
    // older copy than one already shown.
    const mine = this.ownUsable() ? this.cached!.value : null;
    if (mine && (!previous || mine.asOf.getTime() > previous.asOf.getTime())) {
      await this.sh(this.shared.set(OVERVIEW_SHARED_KEY, JSON.stringify(mine), this.remainingLifeMs(mine)));
      previous = mine;
    }
    if (previous && !fresh) return this.remember(previous);

    const token = await this.sh(this.shared.tryLock(OVERVIEW_LOCK_KEY, OVERVIEW_LOCK_TTL_MS));
    if (token) {
      try {
        return await this.computeAndPublish(client);
      } finally {
        // Released on failure too, so a task waiting below sees the lock go
        // with nothing new written and computes for itself: a failure is
        // never published.
        await this.shared.unlock(OVERVIEW_LOCK_KEY, token).catch(() => undefined);
      }
    }

    // Another task is computing. Wait for ITS result rather than start a second
    // set of scans. After Refresh, only a copy NEWER than the one we had counts.
    const isNew = (v: PlatformAnalyticsDto) => !previous || v.asOf.getTime() > previous.asOf.getTime();
    for (let i = 0; i < OVERVIEW_WAIT_POLLS; i++) {
      await new Promise((r) => setTimeout(r, OVERVIEW_WAIT_POLL_MS));
      const now = await this.sh(this.shared.get(OVERVIEW_SHARED_KEY));
      if (now) {
        const v = reviveOverview(now);
        if (isNew(v)) return this.remember(v);
      }
      if (!(await this.sh(this.shared.isLocked(OVERVIEW_LOCK_KEY)))) {
        // The holder finished. One last look, in case it wrote as it released.
        const last = await this.sh(this.shared.get(OVERVIEW_SHARED_KEY));
        if (last) {
          const v = reviveOverview(last);
          if (isNew(v)) return this.remember(v);
        }
        break; // it failed, or its lock expired: nothing to wait for
      }
    }
    // Without the lock, so a task that died holding it can never block this.
    return this.computeAndPublish(client);
  }

  private async computeOverview(client: PrivilegedClient): Promise<PlatformAnalyticsDto> {
    // Stamped BEFORE the reads begin, so it never claims the figures are newer
    // than the oldest row they were built from.
    const asOf = new Date();

    // The growth chart draws SIX months, from the start of the month five
    // before this one. Both monthly reads below are bounded to that window.
    const now = new Date();
    const growthFrom = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const since30 = new Date(Date.now() - 30 * DAY_MS);

    // EVERY READ AT ONCE. None of these depends on another, and they used to
    // run one after the other, so the page cost the SUM of its queries. At the
    // 5,000-school / 2.5M-pupil target that was ~9 s, three queries making up
    // almost all of it. Concurrently, it costs roughly the slowest one. ONE
    // Promise.all rather than promises started early and awaited later: a read
    // that failed before anybody awaited it would be an unhandled rejection,
    // and Node exits on those.
    //
    // Two reads were filtered by `schoolId IN (<every customer id>)`, which made
    // them wait for the school list AND sent a 5,000-element list the planner
    // had to digest. They use the same `isPlatform = false` predicate as the
    // rest of the page, through the relation.
    const [schools, subs, headcounts, studentCreatedAt, pricing, [totals], payments, onboarding, revenueByMonth, demographics] =
      await Promise.all([
        // --- customer schools (exclude the platform org itself) ---
        client.school.findMany({
          where: { isPlatform: false },
          select: { id: true, name: true, status: true, createdAt: true },
        }),
        // --- subscriptions (drives plan mix, MRR, module adoption, risk) ---
        client.schoolSubscription.findMany({
          where: { school: { isPlatform: false } },
          select: { schoolId: true, plan: true, status: true, currency: true, currentPeriodEnd: true, graceDays: true, seats: true, overrides: true },
        }),
        // --- people (students + staff), plus students-per-school for MRR seats + top schools ---
        // COUNTED, not scanned. This used to fetch EVERY user_role row for EVERY
        // customer school into Node and tally them here — unbounded, and at the
        // 5,000-school target that is tens of millions of rows crossing the wire to
        // produce a dozen numbers. It also used a hand-written list of nine staff roles
        // that omitted warden, driver, head_warden, head_driver, librarian and
        // junior_admin, so the fleet staff figure quietly under-reported every boarding
        // school. One grouped query, one shared definition (see operator-people.ts).
        headcountBySchool(client, ALL_CUSTOMER_SCHOOLS),
        // Enrolment by month for the growth chart — a grouped date_trunc rather than
        // pulling every student row back to read one timestamp off each.
        //
        // BOUNDED TO THE CHART, AND READ IN A SHAPE THE PLANNER CANNOT GET WRONG.
        // It read every pupil the platform has EVER had, then threw away all but
        // six months in the bucketing below. Bounding it alone changed nothing,
        // which is what the plan explained: joined through `role.name`, Postgres
        // estimates a role's rows as a nineteenth of `user_role` — 55,000 — when
        // almost all 2.5M are pupils, so it chose 2.5M separate index lookups
        // into "user", and the date filter sat on the far side of them. 3.8 s.
        // The window is now read FIRST, from "user", whose createdAt statistics
        // are accurate, and MATERIALIZED so it cannot be folded back into those
        // lookups: 1.8 s, the same figure for every month the chart draws.
        client.$queryRaw<Array<{ month: Date; count: number }>>(Prisma.sql`
          WITH window_users AS MATERIALIZED (
            SELECT u.id, u."createdAt"
            FROM "user" u
            WHERE u."createdAt" >= ${growthFrom}
              AND ${inSchoolScope(Prisma.sql`u."schoolId"`, ALL_CUSTOMER_SCHOOLS)}
          )
          SELECT date_trunc('month', w."createdAt") AS month, count(*)::int AS count
          FROM window_users w
          JOIN user_role ur ON ur."userId" = w.id
          JOIN role r ON r.id = ur."roleId"
          WHERE r.name = 'student'
          GROUP BY 1
        `),
        this.planPricing.effectiveAll(),
        // --- revenue from PAID platform-subscription payments --- (see the note below)
        client.$queryRaw<Array<{ all_time: bigint | null; last30: bigint | null; n: number }>>(Prisma.sql`
          SELECT COALESCE(SUM("amountMinor"), 0)                                          AS all_time,
                 COALESCE(SUM("amountMinor") FILTER (WHERE "createdAt" >= ${since30}), 0)  AS last30,
                 count(*)::int                                                            AS n
          FROM platform_subscription_payment
          WHERE status = 'PAID'
            AND currency = ${HOME_CURRENCY}
            AND ${inSchoolScope(Prisma.sql`"schoolId"`, ALL_CUSTOMER_SCHOOLS)}
        `),
        // The preview needs TEN rows, and always did — it never needed five thousand.
        client.platformSubscriptionPayment.findMany({
          where: { school: { isPlatform: false }, status: "PAID" },
          select: { schoolId: true, plan: true, amountMinor: true, currency: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
        // --- onboarding intake pipeline (global, RLS-exempt registry table) ---
        client.onboardingRequest.groupBy({ by: ["status"], _count: { _all: true } }),
        // HOME CURRENCY ONLY, exactly as the headline figures above, and GROUPED IN
        // SQL for the same reason they now are: this looped the capped 5,000-row
        // array, so as the platform grew, payments fell out of the window OLDEST
        // FIRST and the historical bars of a growth chart shrank month by month. A
        // chart of the platform's growth that quietly erased its own past.
        client.$queryRaw<Array<{ month: Date; total: bigint | null }>>(Prisma.sql`
          SELECT date_trunc('month', "createdAt") AS month, COALESCE(SUM("amountMinor"), 0) AS total
          FROM platform_subscription_payment
          WHERE status = 'PAID'
            AND "createdAt" >= ${growthFrom}
            AND currency = ${HOME_CURRENCY}
            AND ${inSchoolScope(Prisma.sql`"schoolId"`, ALL_CUSTOMER_SCHOOLS)}
          GROUP BY 1
        `),
        // --- platform-wide student demographics (from profiles across all schools) ---
        // BUCKETED IN POSTGRES, not shipped to Node. This fetched EVERY
        // `student_profile` row on the platform — `{ gender, dateOfBirth }` for every
        // pupil in every school — and tallied them in a JS loop to produce two small
        // histograms. The database answers the same question as an aggregate in
        // ~64ms; the cost was moving the rows and hydrating them.
        //
        // Measured on this box: 0 pupils 0.5s, 200,000 pupils 3.2s — about 15ms per
        // thousand, all of it hydration. A real fleet of 5,000 schools at ~900 pupils
        // is 4.5M profiles, i.e. roughly SEVENTY SECONDS and 4.5M objects live in the
        // API task, on the platform owner's dashboard. It would not time out
        // gracefully; it would take the task's memory with it.
        //
        // THE CORRECT SIBLING WAS ALREADY THERE. `analytics.service.ts` does exactly
        // this in SQL for a SINGLE school, with a comment saying why — "rather than
        // shipping every student_profile row into Node just to tally". The half that
        // was left is the one that runs over five thousand times as many rows.
        //
        // Same shape as that sibling so the two cannot drift: gender is grouped by
        // RAW value and folded through `normalizeGender` over the handful of grouped
        // rows, so the normalisation stays one definition and two spellings of one
        // gender still merge; the age bands are FILTER counts using Postgres `age()`,
        // whose completed-year count matches the pure `ageYears()` these DTOs used
        // before (NULL / out-of-range DOB -> "Unknown").
        //
        // Scoped by `school."isPlatform" = false` rather than a 5,000-element
        // `IN (...)`: the predicate is the same one, expressed where the planner can
        // use it, and it does not grow with the fleet.
        //
        // ONE SCAN, not two. Gender and age were separate queries over the same
        // 2.5M profiles; each gender group now carries its own age bands and the
        // bands are summed across groups below.
        client.$queryRaw<Array<PlatformDemographicRow>>(Prisma.sql`
          SELECT gender,
                 count(*)::int                                          AS n,
                 count(*) FILTER (WHERE age IS NULL)::int              AS unknown,
                 count(*) FILTER (WHERE age <= 5)::int                 AS b0,
                 count(*) FILTER (WHERE age BETWEEN 6 AND 10)::int     AS b1,
                 count(*) FILTER (WHERE age BETWEEN 11 AND 13)::int    AS b2,
                 count(*) FILTER (WHERE age BETWEEN 14 AND 16)::int    AS b3,
                 count(*) FILTER (WHERE age BETWEEN 17 AND 18)::int    AS b4,
                 count(*) FILTER (WHERE age >= 19)::int                AS b5
          FROM (
            SELECT gender, (CASE WHEN a >= 0 AND a < 130 THEN a ELSE NULL END) AS age FROM (
              SELECT p.gender, date_part('year', age(p."dateOfBirth"))::int AS a
              FROM "student_profile" p JOIN "school" s ON s.id = p."schoolId"
              WHERE s."isPlatform" = false
            ) x
          ) t
          GROUP BY gender
        `),
      ]);

    const schoolName = new Map(schools.map((s) => [s.id, s.name]));
    const schoolStatus = { total: schools.length, active: 0, disabled: 0 };
    for (const s of schools) {
      if (s.status === "ACTIVE") schoolStatus.active++;
      else schoolStatus.disabled++;
    }
    const subBySchool = new Map(subs.map((s) => [s.schoolId, s]));

    const studentsBySchool = new Map<string, number>();
    let studentTotal = 0;
    let staffTotal = 0;
    for (const [schoolId, h] of headcounts) {
      studentsBySchool.set(schoolId, h.students);
      studentTotal += h.students;
      staffTotal += h.staff;
    }

    // --- per-school roll-up: effective plan, seats, MRR, effective modules ---
    // THE PRICE THE OPERATOR ACTUALLY SET, in the money each school is billed
    // in. This read `PLAN_PRICING` — the NAIRA fallback table — for every
    // school, so a school paying in dollars or cedis contributed a naira figure
    // to a total that then added them together. That is the "kobo added to
    // cents, which is not money in any currency" defect the payments block
    // below was fixed for; this roll-up sits thirty lines ABOVE it.
    const mrrByCurrency = new Map<string, { totalMinor: number; payingSchools: number }>();
    const atRiskByCurrency = new Map<string, number>();
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
      const mrrCurrency = isCurrency(sub?.currency ?? "") ? (sub!.currency as string) : HOME_CURRENCY;
      const monthly = sessionRunRateMinor(pricing, effective, mrrCurrency, seats);
      const modules = resolveModules(effective, (sub?.overrides as unknown as ModuleOverrides) ?? null);

      schoolsByPlan[effective] = (schoolsByPlan[effective] ?? 0) + 1;
      schoolsByStatus[status] = (schoolsByStatus[status] ?? 0) + 1;
      modulesSum += modules.length;
      for (const m of modules) moduleCount.set(m, (moduleCount.get(m) ?? 0) + 1);

      if (status === SUBSCRIPTION_STATUS.ACTIVE && sub) {
        const row = mrrByCurrency.get(mrrCurrency) ?? { totalMinor: 0, payingSchools: 0 };
        row.totalMinor += monthly;
        row.payingSchools += 1;
        mrrByCurrency.set(mrrCurrency, row);
        payingSchools += 1;
        // The HEADLINE figures stay the home currency alone, exactly as the
        // payments block below already does. `byCurrency` carries the rest.
        if (mrrCurrency === HOME_CURRENCY) {
          mrrTotalMinor += monthly;
          mrrByPlan[effective] = (mrrByPlan[effective] ?? 0) + monthly;
        }
      } else if (status === SUBSCRIPTION_STATUS.PAST_DUE) {
        pastDue += 1;
        atRiskByCurrency.set(mrrCurrency, (atRiskByCurrency.get(mrrCurrency) ?? 0) + monthly);
        if (mrrCurrency === HOME_CURRENCY) atRiskMrrMinor += monthly;
      } else if (status === SUBSCRIPTION_STATUS.CANCELED) {
        canceled += 1;
      }
      return { name: s.name, students, plan: effective, mrrMinor: monthly, mrrCurrency };
    });

    // --- revenue from PAID platform-subscription payments ---
    // CURRENCY IS SELECTED, and the totals below are the platform's HOME
    // currency only. This summed every PAID payment into one number without
    // even reading the currency column — kobo added to cents, which is not
    // money in any currency. It read correctly only because no USD payment had
    // landed yet, so it was a bug with a start date. The full per-currency
    // breakdown lives on the revenue ledger (/operator/payments).
    // TOTALLED IN SQL, NOT BY HYDRATING ROWS.
    //
    // This read the most recent 5,000 payment rows and summed them in Node. The
    // bound was added deliberately — "the unbounded version grew with the
    // platform's whole lifetime" — and it is the right instinct applied to the
    // wrong half: what must not grow is the number of rows crossing the wire,
    // not the number of rows COUNTED. An aggregate counts every row and returns
    // one.
    //
    // The figure is labelled "Revenue · all time" on the console, and once the
    // platform passed 5,000 payments it stopped being that. Worse, the window is
    // newest-first, so older payments FALL OUT as new ones arrive: a lifetime
    // revenue figure that goes DOWN over time, silently. Measured on a
    // 500-school fleet at 6,508 paid payments — the card read NGN 5,000,000.00
    // against a true NGN 30,846,756.64, missing 83.8% of it, and nothing on the
    // screen or in the response said a row had been left out.
    //
    // A capped newest-first list dropping the oldest rows is the defect class
    // this codebase keeps meeting; a revenue total is simply the worst place for
    // it, because the number stays plausible while being wrong.
    // SUM over int8 comes back as BigInt, which JSON.stringify THROWS on — the
    // same trap the school archive records. These are minor units of one
    // currency and comfortably inside Number, so they are narrowed here rather
    // than carried out to the DTO.
    const paidTotalMinor = Number(totals?.all_time ?? 0);
    const last30dMinor = Number(totals?.last30 ?? 0);
    const homeCurrencyPayments = totals?.n ?? 0;

    // The PREVIEW carries every currency — it is a list of individual payments,
    // not a total, so a dollar renewal belongs in it. What it must not do is
    // omit the currency and let the screen choose one, which is what it did.
    const recentPayments = payments.slice(0, 10).map((pay) => ({
      schoolName: schoolName.get(pay.schoolId) ?? "—",
      plan: pay.plan,
      amountMinor: toMinor(pay.amountMinor),
      currency: pay.currency ?? HOME_CURRENCY,
      status: pay.status,
      createdAt: pay.createdAt,
    }));

    // --- onboarding intake pipeline (global, RLS-exempt registry table) ---
    const onboardingPipeline: Record<string, number> = {};
    for (const o of onboarding as Array<{ status: string; _count: { _all: number } }>) {
      onboardingPipeline[o.status] = o._count._all;
    }

    // --- 6-month growth + revenue trend ---
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
    // Already aggregated per month by the query — add the bucket's count rather
    // than incrementing once per student row.
    for (const m of studentCreatedAt) {
      const i = bucketOf.get(keyFor(m.month));
      if (i !== undefined) buckets[i].students += m.count;
    }
    for (const r of revenueByMonth) {
      const i = bucketOf.get(keyFor(r.month));
      if (i !== undefined) buckets[i].revenueMinor += Number(r.total ?? 0);
    }

    // --- demographics: folded from the one grouped scan above ---
    const genderMix: Record<string, number> = {};
    const bands: PlatformAgeBandRow = { unknown: 0, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0 };
    let profiledTotal = 0;
    for (const r of demographics) {
      const g = normalizeGender(r.gender);
      genderMix[g] = (genderMix[g] ?? 0) + r.n;
      profiledTotal += r.n;
      for (const k of Object.keys(bands) as Array<keyof PlatformAgeBandRow>) bands[k] += r[k];
    }
    // Only bands with somebody in them, so the shape of the response is
    // unchanged from the loop it replaces.
    const ageMix: Record<string, number> = {};
    const BANDS: Array<[keyof PlatformAgeBandRow, string]> = [
      ["b0", "5 & under"], ["b1", "6–10"], ["b2", "11–13"],
      ["b3", "14–16"], ["b4", "17–18"], ["b5", "19+"], ["unknown", "Unknown"],
    ];
    for (const [key, label] of BANDS) {
      const n = bands[key];
      if (n > 0) ageMix[label] = n;
    }

    const moduleLabel = new Map(MODULE_CATALOG.map((m) => [m.key, m.label]));
    const moduleAdoption = [...moduleCount.entries()]
      .map(([key, n]) => ({ key, label: moduleLabel.get(key) ?? key, schools: n }))
      .sort((a, b) => b.schools - a.schools);
    const topSchools = perSchool.sort((a, b) => b.students - a.students).slice(0, 6);

    return {
      asOf,
      schools: schoolStatus,
      schoolsByPlan,
      schoolsByStatus,
      people: { students: studentTotal, staff: staffTotal },
      // The COUNT now describes the same set as the TOTAL — home-currency PAID
      // payments. It was `payments.length`, the length of a capped, all-currency
      // array, so it agreed with the money figures beside it about neither the
      // currency nor the number of rows.
      revenue: { paidTotalMinor, payments: homeCurrencyPayments, last30dMinor, currency: HOME_CURRENCY },
      onboardingPipeline,
      recentPayments,
      mrr: {
        totalMinor: mrrTotalMinor,
        byPlan: mrrByPlan,
        // ARPA over the HOME-currency schools only — dividing a naira total by a
        // count that includes dollar-billed schools is an average of nothing.
        arpaMinor: (() => {
          const home = mrrByCurrency.get(HOME_CURRENCY);
          return home && home.payingSchools > 0 ? Math.round(home.totalMinor / home.payingSchools) : 0;
        })(),
        payingSchools,
        byCurrency: [...mrrByCurrency.entries()]
          .map(([currency, v]) => ({ currency, ...v }))
          .sort((a, b) => Number(b.currency === HOME_CURRENCY) - Number(a.currency === HOME_CURRENCY) || b.totalMinor - a.totalMinor),
      },
      growth: buckets.map(({ month, schools: sc, students: st, revenueMinor }) => ({ month, schools: sc, students: st, revenueMinor })),
      funnel: {
        requests: Object.values(onboardingPipeline).reduce((a, b) => a + b, 0),
        approved: onboardingPipeline.APPROVED ?? 0,
        provisioned: schools.length,
        paying: payingSchools,
      },
      risk: {
        pastDue,
        canceled,
        atRiskMrrMinor,
        atRiskByCurrency: [...atRiskByCurrency.entries()]
          .map(([currency, totalMinor]) => ({ currency, totalMinor }))
          .sort((a, b) => Number(b.currency === HOME_CURRENCY) - Number(a.currency === HOME_CURRENCY) || b.totalMinor - a.totalMinor),
      },
      moduleAdoption,
      topSchools,
      averages: {
        studentsPerSchool: schools.length ? Math.round(studentTotal / schools.length) : 0,
        modulesPerSchool: schools.length ? Math.round(modulesSum / schools.length) : 0,
      },
      // `profiled` is the population the histograms were built from — the sum of
      // the gender groups, which is the same set by construction and no longer
      // needs a second pass over four and a half million rows to count.
      demographics: { profiled: profiledTotal, gender: genderMix, ageBand: ageMix },
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
