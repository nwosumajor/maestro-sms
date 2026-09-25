// =============================================================================
// PlatformAnalyticsService — cross-tenant business metrics (unit)
// =============================================================================
// Proves the platform owner's dashboard: excludes the platform org, sums PAID
// revenue, derives effective plan mix + people counts across customer schools,
// and 503s when the privileged client is unconfigured.

import { ServiceUnavailableException } from "@nestjs/common";
import { PLAN_PRICING, PLAN_PRICING_BY_CURRENCY } from "@sms/types";
import { PlatformAnalyticsService } from "../../src/operator/platform-analytics.service";
import { OperatorController } from "../../src/operator/operator.controller";
import { OVERVIEW_SHARED_KEY, reviveOverview } from "../../src/operator/platform-analytics.service";
import { randomUUID } from "node:crypto";
import type { Principal } from "../../src/integrity/integrity.foundation";

const owner: Principal = { schoolId: "platform", userId: "owner", roles: ["super_admin"], permissions: ["platform.operate"] };

function makeClient() {
  const now = new Date();
  /** The two pupils the demographics assertions describe. ONE fixture, served to
   *  both the aggregate double and the (now unused) findMany, so the test cannot
   *  agree with itself while disagreeing with the service. */
  const PROFILE_FIXTURE: Array<{ gender: string | null; dateOfBirth: Date | null }> = [
    { gender: "male", dateOfBirth: new Date("2015-01-01") },
    { gender: "Female", dateOfBirth: new Date("2012-01-01") },
  ];
  /**
   * The revenue figures are AGGREGATED IN SQL now (see
   * `a-lifetime-total-that-shrank`): a capped newest-first page summed in Node
   * made "Revenue · all time" shrink as the platform grew.
   *
   * So the `$queryRaw` double below computes the aggregate FROM THE SAME FIXTURE
   * ROWS the payment mock returns, rather than answering with a constant. A
   * constant would make the assertions below ("naira only", "a dollar stays out
   * of the chart") pass whatever the service did — a double must model the
   * CONTRACT, not merely satisfy the call.
   */
  const paidRows = async (): Promise<Array<{ amountMinor: number; currency?: string; createdAt: Date }>> =>
    (await paymentsFixture({})) as never;

  const client: ReturnType<typeof build> = build();
  // The double reads its fixture through the ORIGINAL mock, so a test that
  // wraps the client's methods sees only the SERVICE's calls, not the double
  // answering itself. Same mock object, so `mockResolvedValue` overrides apply.
  const paymentsFixture = client.platformSubscriptionPayment.findMany;
  return client;

  function build() {
   return {
    school: {
      findMany: jest.fn().mockResolvedValue([
        { id: "s1", name: "Alpha", status: "ACTIVE", createdAt: now },
        { id: "s2", name: "Beta", status: "DISABLED", createdAt: now },
      ]),
    },
    schoolSubscription: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: "s1", plan: "STANDARD", status: "ACTIVE", currentPeriodEnd: null, seats: 10, overrides: null },
        // s2 has no subscription row -> fail-closed to the STANDARD floor (DEFAULT_PLAN).
      ]),
    },
    // People are COUNTED in Postgres now, not fetched and tallied in Node — the
    // scan this replaced pulled every user_role row for every customer school.
    // u3 holds teacher AND principal and is ONE member of staff: the SQL says
    // count(DISTINCT "userId"), so the mock returns the already-deduplicated 1.
    $queryRaw: jest.fn(async (q: unknown) => {
      const sql = JSON.stringify(q);
      if (sql.includes("platform_subscription_payment")) {
        // HONOURS THE QUERY'S OWN currency predicate rather than applying one of
        // its own. A double that always filtered to naira passed against a
        // service that had STOPPED filtering — the fixture trap this repo keeps
        // recording ("a stub whose findMany ignores the where passes against a
        // service that stopped filtering"). Verified by mutation: removing
        // `AND currency = ...` from the aggregate now fails these tests.
        const wants = (q as { values?: unknown[] })?.values?.find(
          (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v),
        ) as string | undefined;
        const filtersCurrency = sql.includes("currency =") && wants !== undefined;
        const home = filtersCurrency
          ? (await paidRows()).filter((r) => (r.currency ?? "NGN") === wants)
          : await paidRows();
        if (sql.includes("date_trunc")) {
          // HONOURS THE QUERY'S OWN window, for the same reason as the currency
          // above: a double that ignored it would pass against a service that
          // stopped bounding the trend.
          const from = (q as { values?: unknown[] })?.values?.find((v): v is Date => v instanceof Date);
          return home
            .filter((r) => !from || r.createdAt >= from)
            .map((r) => ({ month: r.createdAt, total: BigInt(r.amountMinor) }));
        }
        const since30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
        return [
          {
            all_time: BigInt(home.reduce((n, r) => n + r.amountMinor, 0)),
            last30: BigInt(
              home.filter((r) => r.createdAt.getTime() >= since30).reduce((n, r) => n + r.amountMinor, 0),
            ),
            n: home.length,
          },
        ];
      }
      // DEMOGRAPHICS, now counted in Postgres rather than fetched and tallied in
      // Node — the read this replaced pulled EVERY student_profile row on the
      // platform (4.5M at the 5,000-school target) to build two histograms.
      // Computed FROM THE SAME FIXTURE the old `studentProfile.findMany` served,
      // so the assertions below still describe the same two pupils and a double
      // returning fixed numbers could not vouch for a broken query.
      if (sql.includes("student_profile")) {
        // ONE scan now: a row per gender, each carrying its own age bands.
        // Built from the same fixture, so the two figures cannot agree with
        // themselves while disagreeing with the service.
        const age = (d: Date) => Math.floor((now.getTime() - d.getTime()) / (365.25 * 864e5));
        const band = (a: number) =>
          a <= 5 ? "b0" : a <= 10 ? "b1" : a <= 13 ? "b2" : a <= 16 ? "b3" : a <= 18 ? "b4" : "b5";
        const by = new Map<string | null, Record<string, number>>();
        for (const r of PROFILE_FIXTURE) {
          const row = by.get(r.gender) ?? { n: 0, unknown: 0, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0 };
          row.n += 1;
          if (!r.dateOfBirth) row.unknown += 1;
          else row[band(age(r.dateOfBirth))] += 1;
          by.set(r.gender, row);
        }
        return [...by].map(([gender, row]) => ({ gender, ...row }));
      }
      if (sql.includes("date_trunc")) {
        return [{ month: now, count: 2 }]; // both students enrolled this month
      }
      return [{ schoolId: "s1", students: 2, staff: 1, parents: 0 }];
    }),
    user: {
      findMany: jest.fn().mockResolvedValue([{ createdAt: now }, { createdAt: now }]),
    },
    // Kept so a regression to the hydrating read is VISIBLE: if the service goes
    // back to fetching profiles, this spy records the call and the assertion
    // below catches it.
    studentProfile: {
      findMany: jest.fn().mockResolvedValue(PROFILE_FIXTURE),
    },
    platformSubscriptionPayment: {
      findMany: jest.fn().mockResolvedValue([
        { schoolId: "s1", plan: "STANDARD", amountMinor: 500000, status: "PAID", createdAt: now },
        { schoolId: "s1", plan: "STANDARD", amountMinor: 300000, status: "PAID", createdAt: new Date("2020-01-01") },
      ]),
    },
    onboardingRequest: {
      groupBy: jest.fn().mockResolvedValue([
        { status: "NEW", _count: { _all: 2 } },
        { status: "APPROVED", _count: { _all: 1 } },
      ]),
    },
  };
  }
}

/**
 * An in-memory stand-in for Redis that models the CONTRACT the service relies
 * on, not just its method names: values EXPIRE (on the faked clock), a lock is
 * EXCLUSIVE until it expires, only the token that took a lock can release it,
 * `offline` is a connection that is known to be down (`available` false), and
 * `failing` is one that looks up and fails every command — a Redis that is
 * reachable but broken, the case a fallback is actually for.
 */
function fakeRedis() {
  const store = new Map<string, { v: string; until: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (!e) return null;
    if (Date.now() >= e.until) {
      store.delete(k);
      return null;
    }
    return e;
  };
  const r = {
    store,
    offline: false,
    failing: false,
    get available() {
      return !r.offline;
    },
    guard() {
      if (r.offline || r.failing) throw new Error("redis unavailable");
    },
    async get(k: string) {
      r.guard();
      return live(k)?.v ?? null;
    },
    async set(k: string, v: string, ttl: number) {
      r.guard();
      store.set(k, { v, until: Date.now() + ttl });
    },
    async tryLock(k: string, ttl: number) {
      r.guard();
      if (live(k)) return null;
      const t = randomUUID();
      store.set(k, { v: t, until: Date.now() + ttl });
      return t;
    },
    async unlock(k: string, t: string) {
      r.guard();
      if (live(k)?.v === t) store.delete(k);
    },
    async isLocked(k: string) {
      r.guard();
      return live(k) !== null;
    },
  };
  return r;
}

/** Wait for the recalculation a stale read started in the background. */
async function backgroundOf(service: unknown): Promise<void> {
  await (service as { revalidating: Promise<void> | null }).revalidating;
}

function makeService(client: ReturnType<typeof makeClient> | null, shared: unknown = { available: false }) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const db = { runAsTenant: <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({}) };
  const privileged = { client };
  // The SHIPPED price lists, so MRR is asserted against real figures in each
  // school's own currency rather than an invented table.
  const planPricing = { effectiveAll: async () => PLAN_PRICING_BY_CURRENCY };
  return {
    service: new PlatformAnalyticsService(db as never, audit as never, privileged as never, planPricing as never, shared as never),
    audit,
  };
}

describe("PlatformAnalyticsService", () => {
  it("aggregates schools, plan mix, people and revenue across customer tenants", async () => {
    const client = makeClient();
    const { service } = makeService(client);
    const out = await service.overview(owner);

    expect(out.schools).toEqual({ total: 2, active: 1, disabled: 1 });
    // s1 STANDARD (active) + s2 no-sub -> fail-closed STANDARD floor (DEFAULT_PLAN).
    expect(out.schoolsByPlan).toEqual({ STANDARD: 2 });
    expect(out.schoolsByStatus.ACTIVE).toBe(2); // both effectively active
    expect(out.people).toEqual({ students: 2, staff: 1 }); // u3 counted once
    expect(out.revenue.paidTotalMinor).toBe(800000);
    expect(out.revenue.payments).toBe(2);
    expect(out.revenue.last30dMinor).toBe(500000); // only the recent one
    expect(out.onboardingPipeline).toEqual({ NEW: 2, APPROVED: 1 });
    expect(out.recentPayments[0].schoolName).toBe("Alpha");

    // --- extended decision-grade metrics ---
    // s1 STANDARD active, 10 seats at the STANDARD per-seat rate; s2 no-sub = not
    // paying. DERIVED from PLAN_PRICING rather than a typed-in figure — the rate
    // moved when the code fallback was brought back in line with what is actually
    // charged, and a hard-coded 200000 turned a pricing change into a failure in
    // an analytics test that is not about pricing at all.
    expect(out.mrr.totalMinor).toBe(10 * PLAN_PRICING.STANDARD.perSeatSessionMinor);
    expect(out.mrr.byPlan.STANDARD).toBe(10 * PLAN_PRICING.STANDARD.perSeatSessionMinor);
    expect(out.mrr.payingSchools).toBe(1);
    expect(out.mrr.arpaMinor).toBe(10 * PLAN_PRICING.STANDARD.perSeatSessionMinor);
    // funnel: 3 requests total, 1 approved, 2 provisioned schools, 1 paying.
    expect(out.funnel).toEqual({ requests: 3, approved: 1, provisioned: 2, paying: 1 });
    expect(out.risk).toEqual({ pastDue: 0, canceled: 0, atRiskMrrMinor: 0, atRiskByCurrency: [] });
    expect(out.growth).toHaveLength(6); // last 6 months
    expect(out.topSchools[0].name).toBe("Alpha"); // 2 students > 0
    expect(out.moduleAdoption.length).toBeGreaterThan(0);
    // demographics: normalised gender across all profiles.
    expect(out.demographics.profiled).toBe(2);
    expect(out.demographics.gender).toEqual({ Male: 1, Female: 1 });
  });

  it("COUNTS the demographics in Postgres — it never fetches the profiles", async () => {
    // THE DEFECT THIS EXISTS FOR. It fetched every `student_profile` row on the
    // platform — `{ gender, dateOfBirth }` for every pupil in every school — and
    // tallied them in a JS loop for two small histograms. Measured live: 0.5s at
    // zero pupils, 3.2s at 200,000 — about 15ms per thousand, all of it
    // hydration, while Postgres answers the same question as an aggregate in
    // 64ms. A real fleet of 5,000 schools at ~900 pupils is 4.5M profiles, i.e.
    // roughly SEVENTY SECONDS and 4.5M objects live in the API task, on the
    // platform owner's own dashboard.
    //
    // The per-school sibling in `analytics.service.ts` already did this in SQL,
    // with a comment saying why. The half left behind was the one running over
    // five thousand times as many rows.
    const client = makeClient();
    const { service } = makeService(client);
    await service.overview(owner);
    expect(client.studentProfile.findMany).not.toHaveBeenCalled();
    const sql = (client.$queryRaw as jest.Mock).mock.calls.map((c) => JSON.stringify(c[0])).join(" ");
    expect(sql).toContain("student_profile");
  });

  it("keeps a DOLLAR payment out of both the headline AND the chart", async () => {
    // The headline figures already filtered to the home currency and explained
    // at length why ("kobo added to cents ... a bug with a start date"). The
    // six-month revenue TREND, twenty-five lines below, added every currency —
    // so one screen reported a total that excluded USD and drew a bar chart
    // beside it that folded USD cents into naira kobo. Sibling asymmetry, with
    // the reasoning already written next to the half that was right.
    const client = makeClient();
    const now = new Date();
    client.platformSubscriptionPayment.findMany.mockResolvedValue([
      { schoolId: "s1", plan: "STANDARD", amountMinor: 500000, currency: "NGN", status: "PAID", createdAt: now },
      { schoolId: "s1", plan: "ENTERPRISE", amountMinor: 249900, currency: "USD", status: "PAID", createdAt: now },
    ]);
    const { service } = makeService(client);
    const out = await service.overview(owner);

    expect(out.revenue.paidTotalMinor).toBe(500000); // naira only
    expect(out.revenue.currency).toBe("NGN"); // and it SAYS so
    // `payments` COUNTS THE SAME SET AS THE TOTAL — one naira payment here, not
    // two. It used to be the length of the fetched (capped, all-currency) array,
    // so it agreed with the money beside it about neither the currency nor the
    // number of rows: a card reading "2 payments" above a total that covered
    // one. Two different populations under one heading is not a distinction a
    // reader can see, and nothing on the screen drew it.
    expect(out.revenue.payments).toBe(1);

    const thisMonth = out.growth[out.growth.length - 1];
    expect(thisMonth.revenueMinor).toBe(500000); // was 749900 — cents as kobo
  });

  it("gives each recent payment the currency it was charged in", async () => {
    // The preview lists INDIVIDUAL payments, so a dollar renewal belongs in it
    // — it just has to say it is dollars. The row carried the figure and no
    // currency, so the screen rendered it under a naira sign.
    const client = makeClient();
    const now = new Date();
    client.platformSubscriptionPayment.findMany.mockResolvedValue([
      { schoolId: "s1", plan: "ENTERPRISE", amountMinor: 249900, currency: "USD", status: "PAID", createdAt: now },
    ]);
    const { service } = makeService(client);
    const out = await service.overview(owner);
    expect(out.recentPayments[0]).toMatchObject({ amountMinor: 249900, currency: "USD" });
  });

  it("excludes the platform org from the school query", async () => {
    const client = makeClient();
    const { service } = makeService(client);
    await service.overview(owner);
    expect(client.school.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isPlatform: false } }),
    );
    // The subscriptions and the payment preview used to be narrowed by an
    // explicit list of every customer id taken from that school read. They now
    // carry the predicate themselves, so each must say so.
    expect(client.schoolSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { school: { isPlatform: false } } }),
    );
    expect(client.platformSubscriptionPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ school: { isPlatform: false } }) }),
    );
  });

  it("issues every read before any of them settles", async () => {
    // THE DEFECT THIS EXISTS FOR: ten independent reads awaited one after
    // another, so the dashboard cost the SUM of its queries — about 9 s at
    // 5,000 schools and 2.5M pupils. Run together it costs roughly the slowest.
    // A return to sequential awaits changes no figure on the page, so without
    // this nothing would notice the page getting slow again.
    const client = makeClient();
    let issued = 0;
    let issuedWhenFirstSettled: number | null = null;
    const slow = (fn: jest.Mock) =>
      jest.fn(async (...args: unknown[]) => {
        issued += 1;
        await new Promise((r) => setImmediate(r));
        if (issuedWhenFirstSettled === null) issuedWhenFirstSettled = issued;
        return fn(...args);
      });
    client.$queryRaw = slow(client.$queryRaw as jest.Mock) as never;
    client.school.findMany = slow(client.school.findMany) as never;
    client.schoolSubscription.findMany = slow(client.schoolSubscription.findMany) as never;
    client.platformSubscriptionPayment.findMany = slow(client.platformSubscriptionPayment.findMany) as never;
    client.onboardingRequest.groupBy = slow(client.onboardingRequest.groupBy) as never;

    const { service } = makeService(client);
    await service.overview(owner);
    expect(issued).toBeGreaterThanOrEqual(8); // it made the reads at all
    expect(issuedWhenFirstSettled).toBe(issued);
  });

  it("bounds both monthly reads to the six months the chart draws", async () => {
    // The growth chart draws six months and used to read every month the
    // platform has existed, discarding the rest in the bucketing. Both monthly
    // reads carry the window's first day.
    const client = makeClient();
    const { service } = makeService(client);
    const out = await service.overview(owner);
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const monthly = (client.$queryRaw as jest.Mock).mock.calls
      .map((c) => c[0] as { sql?: string; values?: unknown[] })
      .filter((q) => (q.sql ?? "").includes("date_trunc"));
    expect(monthly).toHaveLength(2); // pupils joined, and revenue
    for (const q of monthly) {
      expect(q.values?.some((v) => v instanceof Date && v.getTime() === first.getTime())).toBe(true);
    }
    expect(out.growth).toHaveLength(6);
  });

  describe("the one-minute copy", () => {
    // Every computation is three full scans of the fleet (~3.6 s at 5,000
    // schools), so the overview is kept for a minute. What the copy must and
    // must not do, each proven below.
    const T0 = new Date("2026-09-25T09:00:00Z");
    beforeEach(() => {
      // Only the CLOCK is faked; setImmediate and friends stay real.
      jest.useFakeTimers({
        now: T0,
        doNotFake: ["hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate",
          "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
      });
    });
    afterEach(() => {
      // CLEARED, not merely switched off — a leftover handle kills the worker
      // for whichever file runs next (CLAUDE.md, "Fake timers must be CLEARED").
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it("serves one computation for a minute, and says when it was made", async () => {
      const client = makeClient();
      const { service } = makeService(client);
      const first = await service.overview(owner);
      jest.setSystemTime(new Date(T0.getTime() + 59_000));
      const second = await service.overview(owner);
      expect(client.school.findMany).toHaveBeenCalledTimes(1);
      expect(second.asOf).toEqual(T0); // the time of the READ, not of this request
      expect(second).toBe(first);
    });

    it("past its minute, serves the previous copy AT ONCE and recalculates behind it", async () => {
      // Nobody waits on an expiry. The first open after the minute gets the
      // previous copy immediately; the next copy is calculated in the
      // background, and the open after it is served that.
      const client = makeClient();
      const { service } = makeService(client);
      const first = await service.overview(owner);
      jest.setSystemTime(new Date(T0.getTime() + 60_001));
      const atExpiry = await service.overview(owner);
      expect(atExpiry.asOf.getTime()).toBe(first.asOf.getTime()); // served, not waited for
      await backgroundOf(service);
      const next = await service.overview(owner);
      expect(client.school.findMany).toHaveBeenCalledTimes(2);
      expect(next.asOf.getTime()).toBe(T0.getTime() + 60_001);
    });

    it("past its grace, the copy is GONE and an open waits for a new one", async () => {
      // A dashboard nobody has looked at recalculates on demand; a stale copy is
      // not kept alive for ever.
      const client = makeClient();
      const { service } = makeService(client);
      await service.overview(owner);
      jest.setSystemTime(new Date(T0.getTime() + 120_001));
      const later = await service.overview(owner);
      expect(later.asOf.getTime()).toBe(T0.getTime() + 120_001);
      expect(client.school.findMany).toHaveBeenCalledTimes(2);
    });

    it("recomputes on request — the Refresh button", async () => {
      const client = makeClient();
      const { service } = makeService(client);
      await service.overview(owner);
      jest.setSystemTime(new Date(T0.getTime() + 5_000));
      const fresh = await service.overview(owner, { fresh: true });
      expect(client.school.findMany).toHaveBeenCalledTimes(2);
      expect(fresh.asOf.getTime()).toBe(T0.getTime() + 5_000);
    });

    it("shares a computation already running instead of starting a second", async () => {
      const client = makeClient();
      const { service } = makeService(client);
      const [a, b] = await Promise.all([service.overview(owner), service.overview(owner, { fresh: true })]);
      expect(client.school.findMany).toHaveBeenCalledTimes(1);
      expect(b).toBe(a);
    });

    it("never keeps a FAILED computation", async () => {
      // An error cached for a minute would be a minute of outage from one blip.
      const client = makeClient();
      const real = client.$queryRaw as jest.Mock;
      client.$queryRaw = jest.fn().mockRejectedValueOnce(new Error("pool busy")).mockImplementation(real) as never;
      const { service } = makeService(client);
      await expect(service.overview(owner)).rejects.toThrow("pool busy");
      const retry = await service.overview(owner);
      expect(client.school.findMany).toHaveBeenCalledTimes(2);
      expect(retry.schools.total).toBe(2);
    });
  });

  describe("one copy shared by every API task", () => {
    // Production runs at least two API tasks. A copy in process memory is a copy
    // PER TASK: reloads could disagree, and after Refresh the "as of" time could
    // go BACKWARDS when the next reload lands on a task still holding its older
    // copy. Two service instances over one Redis stand in for two tasks.
    const T0 = new Date("2026-09-25T09:00:00Z");
    beforeEach(() => {
      jest.useFakeTimers({
        now: T0,
        doNotFake: ["hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate",
          "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
      });
    });
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    const twoTasks = () => {
      const redis = fakeRedis();
      const a = makeClient();
      const b = makeClient();
      return { redis, a, b, taskA: makeService(a, redis).service, taskB: makeService(b, redis).service };
    };

    it("serves one task's computation from every task", async () => {
      const { a, b, taskA, taskB } = twoTasks();
      const first = await taskA.overview(owner);
      const second = await taskB.overview(owner);
      expect(a.school.findMany).toHaveBeenCalledTimes(1);
      expect(b.school.findMany).not.toHaveBeenCalled();
      expect(second.asOf.getTime()).toBe(first.asOf.getTime());
    });

    it("never shows an OLDER time after Refresh, whichever task the next reload lands on", async () => {
      const { taskA, taskB } = twoTasks();
      await taskB.overview(owner); // B holds the 09:00:00 figures
      jest.setSystemTime(new Date(T0.getTime() + 5_000));
      const refreshed = await taskA.overview(owner, { fresh: true }); // Refresh lands on A
      const reload = await taskB.overview(owner); // the next reload lands on B
      expect(refreshed.asOf.getTime()).toBe(T0.getTime() + 5_000);
      expect(reload.asOf.getTime()).toBe(refreshed.asOf.getTime());
    });

    it("recomputes on ONE task while the other waits for its result", async () => {
      const { a, b, taskA, taskB } = twoTasks();
      const [x, y] = await Promise.all([taskA.overview(owner, { fresh: true }), taskB.overview(owner, { fresh: true })]);
      const computations = a.school.findMany.mock.calls.length + b.school.findMany.mock.calls.length;
      expect(computations).toBe(1);
      expect(y.asOf.getTime()).toBe(x.asOf.getTime());
    });

    it("never publishes a FAILED computation — the waiting task computes for itself", async () => {
      const { redis, a, taskA, taskB } = twoTasks();
      const real = a.$queryRaw as jest.Mock;
      a.$queryRaw = jest.fn().mockRejectedValueOnce(new Error("pool busy")).mockImplementation(real) as never;
      const [x, y] = await Promise.allSettled([taskA.overview(owner), taskB.overview(owner)]);
      expect(x.status).toBe("rejected");
      expect(y.status).toBe("fulfilled");
      const published = redis.store.get(OVERVIEW_SHARED_KEY);
      expect(published).toBeDefined();
      expect(reviveOverview(published!.v).schools.total).toBe(2); // B's good result, not an error
      expect(redis.store.has(`${OVERVIEW_SHARED_KEY}:lock`)).toBe(false); // A released it on failure
    });

    it("falls back to this task's own copy when Redis is known to be down", async () => {
      const redis = fakeRedis();
      redis.offline = true;
      const c = makeClient();
      const { service } = makeService(c, redis);
      await service.overview(owner);
      await service.overview(owner);
      expect(c.school.findMany).toHaveBeenCalledTimes(1); // local copy served the second
    });

    it("falls back, rather than failing, when Redis looks up but every command fails", async () => {
      const redis = fakeRedis();
      redis.failing = true;
      const c = makeClient();
      const { service } = makeService(c, redis);
      const out = await service.overview(owner);
      expect(out.schools.total).toBe(2);
    });

    it("does not retry a failed COMPUTATION as if Redis were the problem", async () => {
      // A database failure must propagate. Mistaking it for a cache outage would
      // run the whole failing computation a second time on every request.
      const redis = fakeRedis();
      const c = makeClient();
      c.$queryRaw = jest.fn().mockRejectedValue(new Error("pool busy")) as never;
      const { service } = makeService(c, redis);
      await expect(service.overview(owner)).rejects.toThrow("pool busy");
      expect(c.school.findMany).toHaveBeenCalledTimes(1);
    });

    it("after a Redis outage, publishes a NEWER copy held locally instead of serving the older shared one", async () => {
      // During an outage each task runs on its own copy; a task that
      // recomputed then holds figures newer than the copy still in Redis.
      // Serving the shared one would take anyone who saw the newer figures
      // backwards. The run before this fix: 11 of 49 requests in the ten
      // seconds after Redis returned saw an older copy than one already shown.
      const { redis, taskA, taskB } = twoTasks();
      const before = await taskA.overview(owner); // T0, shared
      redis.failing = true;
      jest.setSystemTime(new Date(T0.getTime() + 5_000));
      const duringOutage = await taskB.overview(owner, { fresh: true }); // T0+5, local only
      expect(duringOutage.asOf.getTime()).toBeGreaterThan(before.asOf.getTime());
      redis.failing = false;
      jest.setSystemTime(new Date(T0.getTime() + 6_000));
      const fromB = await taskB.overview(owner); // B notices the shared copy is older
      const fromA = await taskA.overview(owner); // and A now serves B's newer copy
      expect(fromB.asOf.getTime()).toBe(duringOutage.asOf.getTime());
      expect(fromA.asOf.getTime()).toBe(duringOutage.asOf.getTime());
      // Published with what was LEFT of its minute, not a fresh minute.
      const entry = redis.store.get(OVERVIEW_SHARED_KEY)!;
      expect(entry.until).toBe(duringOutage.asOf.getTime() + 120_000); // its minute + the grace
    });

    it("serves an ordinary open the CURRENT copy while a Refresh recalculates on the same task", async () => {
      // It used to join whatever was running on the task — including someone
      // else's Refresh — and wait seconds for figures it had not asked for.
      // The simulation: 50 of 70 slow ordinary opens were exactly that.
      const redis = fakeRedis();
      const c = makeClient();
      const { service } = makeService(c, redis);
      const current = await service.overview(owner); // a copy exists (T0)

      // Hold the Refresh's database read open until we say so.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const realFind = c.school.findMany;
      c.school.findMany = jest.fn(async (...a: unknown[]) => {
        await gate;
        return (realFind as jest.Mock)(...a);
      }) as never;
      jest.setSystemTime(new Date(T0.getTime() + 5_000));
      const refresh = service.overview(owner, { fresh: true });

      const ordinary = await service.overview(owner); // must NOT wait for the gate
      expect(ordinary.asOf.getTime()).toBe(current.asOf.getTime());

      release();
      expect((await refresh).asOf.getTime()).toBe(T0.getTime() + 5_000);
    });

    it("at the minute, ONE task recalculates in the background while every task serves the previous copy", async () => {
      const { a, b, taskA, taskB } = twoTasks();
      const first = await taskA.overview(owner);
      jest.setSystemTime(new Date(T0.getTime() + 61_000));
      const [x, y] = await Promise.all([taskA.overview(owner), taskB.overview(owner)]);
      expect(x.asOf.getTime()).toBe(first.asOf.getTime()); // neither waited
      expect(y.asOf.getTime()).toBe(first.asOf.getTime());
      await Promise.all([backgroundOf(taskA), backgroundOf(taskB)]);
      const computations = a.school.findMany.mock.calls.length + b.school.findMany.mock.calls.length;
      expect(computations).toBe(2); // the first, then ONE background recalculation
      const [x2, y2] = await Promise.all([taskA.overview(owner), taskB.overview(owner)]);
      expect(x2.asOf.getTime()).toBe(T0.getTime() + 61_000);
      expect(y2.asOf.getTime()).toBe(T0.getTime() + 61_000);
    });

    it("a FAILED background recalculation publishes nothing and keeps serving the previous copy", async () => {
      const { redis, a, taskA } = twoTasks();
      const first = await taskA.overview(owner);
      const real = a.$queryRaw as jest.Mock;
      a.$queryRaw = jest.fn().mockRejectedValueOnce(new Error("pool busy")).mockImplementation(real) as never;
      jest.setSystemTime(new Date(T0.getTime() + 61_000));
      const stale = await taskA.overview(owner);
      await backgroundOf(taskA);
      expect(stale.asOf.getTime()).toBe(first.asOf.getTime());
      expect(reviveOverview(redis.store.get(OVERVIEW_SHARED_KEY)!.v).asOf.getTime()).toBe(first.asOf.getTime());
      expect(redis.store.has(`${OVERVIEW_SHARED_KEY}:lock`)).toBe(false); // released
      const again = await taskA.overview(owner); // still served, and it tries again
      expect(again.asOf.getTime()).toBe(first.asOf.getTime());
    });

    it("brings back every Date in the response as a Date", async () => {
      // A DTO read back from Redis has ISO strings where the type says Date.
      // This walks a REAL computed response, so a Date field added to the DTO
      // later without being revived fails here.
      const { service } = makeService(makeClient());
      const computed = await service.overview(owner);
      const datesIn = (x: unknown, path = ""): Array<[string, number]> =>
        x instanceof Date
          ? [[path, x.getTime()]]
          : x && typeof x === "object"
            ? Object.entries(x).flatMap(([k, v]) => datesIn(v, `${path}.${k}`))
            : [];
      const before = datesIn(computed);
      expect(before.length).toBeGreaterThanOrEqual(2); // asOf and a payment's createdAt at least
      expect(datesIn(reviveOverview(JSON.stringify(computed)))).toEqual(before);
    });
  });

  describe("the route", () => {
    // Only the analytics service is supplied: the handler touches nothing else,
    // and constructing the whole controller would test its wiring, not this.
    const handler = (svc: unknown) => (fresh?: string) =>
      OperatorController.prototype.analytics.call({ analyticsSvc: svc } as never, owner, fresh);

    it("passes ?fresh=1 through, and nothing else counts as fresh", async () => {
      const svc = { overview: jest.fn().mockResolvedValue({}), auditView: jest.fn().mockResolvedValue(undefined) };
      await handler(svc)("1");
      await handler(svc)(undefined);
      await handler(svc)("true");
      expect(svc.overview.mock.calls.map((c) => c[1])).toEqual([{ fresh: true }, { fresh: false }, { fresh: false }]);
    });

    it("audits EVERY view, including one served from the copy", async () => {
      // The log records who looked. How the figures were produced is not a
      // reason to leave a cross-tenant read out of it.
      const client = makeClient();
      const { service, audit } = makeService(client);
      const view = handler(service);
      await view(undefined);
      await view(undefined); // served from the copy
      expect(client.school.findMany).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(2);
    });
  });

  it("503s when the privileged client is not configured", async () => {
    const { service } = makeService(null);
    await expect(service.overview(owner)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("audits the view under the operator's own tenant", async () => {
    const { service, audit } = makeService(makeClient());
    await service.auditView(owner);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "operator.analytics.view", schoolId: "platform" }),
      expect.anything(),
    );
  });
});
