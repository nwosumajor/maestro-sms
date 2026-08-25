// =============================================================================
// OperatorPaymentsService — the platform revenue ledger's accuracy rules
// =============================================================================
// The defect this screen exists partly to prevent: the analytics page summed
// every PAID payment into ONE total without selecting the currency column, so
// kobo was added to cents. It read correctly only because no USD payment had
// landed yet — a bug with a start date.
//
// So the properties pinned here are about the SHAPE of the answer, not the
// arithmetic: totals come back per-currency always, a period includes its last
// day, and a school search that matches nothing returns nothing rather than
// silently widening to the whole platform.
// =============================================================================

import { ServiceUnavailableException } from "@nestjs/common";
import { OperatorPaymentsService } from "../../src/operator/operator-payments.service";

const OPERATOR = { userId: "u-owner", schoolId: "platform-org", roles: ["super_admin"], permissions: [] } as never;

function makeService(opts: {
  grouped?: Array<Record<string, unknown>>;
  rows?: Array<Record<string, unknown>>;
  schools?: Array<{ id: string; name: string }>;
  /** Rows the take-rate aggregate comes back with, one per currency. */
  feeRows?: Array<Record<string, unknown>>;
  noClient?: boolean;
}) {
  const groupBy = jest.fn().mockResolvedValue(opts.grouped ?? []);
  const findMany = jest.fn().mockResolvedValue(opts.rows ?? []);
  const count = jest.fn().mockResolvedValue((opts.rows ?? []).length);
  const schoolFindMany = jest.fn().mockResolvedValue(opts.schools ?? []);
  const queryRaw = jest.fn().mockResolvedValue(opts.feeRows ?? []);
  const audit = { record: jest.fn() };
  const svc = Object.create(OperatorPaymentsService.prototype) as OperatorPaymentsService;
  Object.assign(svc, {
    audit,
    db: { runAsTenant: jest.fn(async (_c: unknown, fn: (t: unknown) => unknown) => fn({})) },
    privileged: {
      client: opts.noClient
        ? null
        : {
            platformSubscriptionPayment: { groupBy, findMany, count },
            school: { findMany: schoolFindMany },
            $queryRaw: queryRaw,
          },
    },
  });
  return { svc, groupBy, findMany, count, schoolFindMany, queryRaw, audit };
}

const paid = (currency: string, sum: number, n: number) => ({
  currency,
  status: "PAID",
  _sum: { amountMinor: sum },
  _count: { _all: n },
});

describe("the take-rate on fee collection — the other half of the income", () => {
  // `payment.platformFeeMinor` is stamped onto every settled online fee payment
  // by the settlement path. It was WRITTEN AND READ BY NOTHING: no DTO, no
  // endpoint and no screen in the product mentioned the column, so the owner
  // who sets the rate had no way to see what it earned. Subscriptions had a
  // ledger; the lever the whole fee rail exists to monetise did not.
  it("comes back per currency, like every other money figure here", async () => {
    const { svc } = makeService({
      feeRows: [
        { currency: "NGN", feeMinor: 4_812_500, payments: 3_210, collectedMinor: 320_833_333 },
        { currency: "GHS", feeMinor: 91_400, payments: 61, collectedMinor: 6_093_333 },
      ],
    });
    const out = await svc.list(OPERATOR, {});
    expect(out.feeRevenue.map((f) => [f.currency, f.feeMinor])).toEqual([
      ["NGN", 4_812_500],
      ["GHS", 91_400],
    ]);
    // A payment inherits its INVOICE's currency; assuming naira would have
    // reported a Ghanaian school's cedi cut as naira and added it to the naira
    // line. Nothing carries the sum.
    expect(JSON.stringify(out.feeRevenue)).not.toContain(String(4_812_500 + 91_400));
  });

  it("takes the DATE RANGE from the filter and nothing else", async () => {
    // The other filters describe SUBSCRIPTION payments — a plan, a subscription
    // status, a school search over the subscription ledger — and mean nothing
    // to a fee take-rate. Quietly reinterpreting them would make this figure
    // move for reasons its own label does not explain.
    const { svc, queryRaw } = makeService({ feeRows: [] });
    await svc.list(OPERATOR, { from: "2026-07-01", to: "2026-07-31", plan: "ULTIMATE", status: "FAILED" });
    const sql = JSON.stringify(queryRaw.mock.calls[0]?.[0] ?? {});
    expect(sql).not.toContain("ULTIMATE");
    expect(sql).not.toContain("FAILED");
    // The range IS applied — and `to` covers the whole of its last day, which
    // for a month-end report is the busiest day in it.
    expect(sql).toContain("2026-07-01T00:00:00.000Z");
    expect(sql).toContain("2026-07-31T23:59:59.999Z");
  });

  it("says nothing rather than zero when no cut was taken", async () => {
    // An empty list renders as "no fee-collection revenue in this period",
    // which is a different statement from "we earned 0.00" under a currency
    // symbol the platform picked for itself.
    const { svc } = makeService({ feeRows: [] });
    expect((await svc.list(OPERATOR, {})).feeRevenue).toEqual([]);
  });
});

describe("operator revenue ledger", () => {
  afterEach(() => jest.restoreAllMocks());

  it("NEVER sums across currencies — one total per currency", async () => {
    const { svc } = makeService({
      grouped: [paid("NGN", 320_981_250, 2), paid("USD", 256_785, 1)],
    });
    const out = await svc.list(OPERATOR, {});
    expect(out.totals).toHaveLength(2);
    const ngn = out.totals.find((t) => t.currency === "NGN");
    const usd = out.totals.find((t) => t.currency === "USD");
    expect(ngn?.paidMinor).toBe(320_981_250);
    expect(usd?.paidMinor).toBe(256_785);
    // The whole point: no field anywhere carries their sum.
    expect(JSON.stringify(out.totals)).not.toContain(String(320_981_250 + 256_785));
  });

  it("counts only PAID as revenue — pending, failed and abandoned stay separate", async () => {
    const { svc } = makeService({
      grouped: [
        paid("NGN", 100, 1),
        { currency: "NGN", status: "PENDING", _sum: { amountMinor: 900 }, _count: { _all: 3 } },
        { currency: "NGN", status: "FAILED", _sum: { amountMinor: 50 }, _count: { _all: 2 } },
        { currency: "NGN", status: "ABANDONED", _sum: { amountMinor: 70 }, _count: { _all: 4 } },
      ],
    });
    const t = (await svc.list(OPERATOR, {})).totals[0];
    // Money that has not arrived is not revenue, and money that never existed
    // is not money — conflating them turns a forecast into fiction.
    expect(t).toMatchObject({
      paidMinor: 100,
      paidCount: 1,
      pendingMinor: 900,
      pendingCount: 3,
      failedCount: 2,
      abandonedCount: 4,
    });
  });

  it("includes the WHOLE of the 'to' day", async () => {
    // Month-end is the busiest day of a finance period; treating `to` as
    // midnight silently drops it.
    const { svc, count } = makeService({});
    await svc.list(OPERATOR, { from: "2026-08-01", to: "2026-08-31" });
    const where = count.mock.calls[0][0].where as { createdAt: { gte: Date; lte: Date } };
    expect(where.createdAt.gte.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(where.createdAt.lte.toISOString()).toBe("2026-08-31T23:59:59.999Z");
  });

  it("a school search matching NOTHING returns nothing, never everything", async () => {
    // Omitting the clause would widen the query to the whole platform — the
    // wrong direction to fail on a revenue screen.
    const { svc, count } = makeService({ schools: [] });
    await svc.list(OPERATOR, { q: "no such school" });
    const where = count.mock.calls[0][0].where as { schoolId: { in: string[] } };
    expect(where.schoolId).toEqual({ in: [] });
  });

  it("totals describe the WHOLE filter, not the visible page", async () => {
    // The aggregate must be given the same where clause as the count, with no
    // skip/take — a total that silently described 25 rows would still look
    // authoritative.
    const { svc, groupBy, count } = makeService({ grouped: [paid("NGN", 500, 1)] });
    await svc.list(OPERATOR, { status: "PAID", page: 3, pageSize: 25 });
    expect(groupBy.mock.calls[0][0].where).toEqual(count.mock.calls[0][0].where);
    expect(groupBy.mock.calls[0][0]).not.toHaveProperty("skip");
    expect(groupBy.mock.calls[0][0]).not.toHaveProperty("take");
  });

  it("audits every cross-tenant read", async () => {
    const { svc, audit } = makeService({});
    await svc.list(OPERATOR, { from: "2026-01-01" });
    expect(audit.record).toHaveBeenCalled();
    expect(audit.record.mock.calls[0][0]).toMatchObject({ action: "platform.revenue.read" });
  });

  it("REFUSES rather than reporting an empty ledger when it cannot read", async () => {
    // A finance screen rendering an empty table when the read failed is worse
    // than one that errors — it looks like "no payments".
    const { svc } = makeService({ noClient: true });
    await expect(svc.list(OPERATOR, {})).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("neutralises spreadsheet formulas in the CSV export", async () => {
    const { svc } = makeService({
      rows: [
        {
          id: "p1",
          schoolId: "s1",
          reference: "=cmd|'/c calc'!A1",
          plan: "STANDARD",
          billingCycle: "TERM",
          kind: "RENEWAL",
          seats: 5,
          amountMinor: 1000,
          currency: "NGN",
          status: "PAID",
          periodStart: null,
          periodEnd: null,
          paidAt: null,
          createdAt: new Date("2026-08-01T10:00:00Z"),
        },
      ],
      schools: [{ id: "s1", name: "=HYPERLINK(1)" }],
    });
    const { csv } = await svc.csv(OPERATOR, {});
    // Both the gateway reference and the school NAME are attacker-influenced.
    expect(csv).toContain(`"'=cmd|'/c calc'!A1"`);
    expect(csv).toContain(`"'=HYPERLINK(1)"`);
  });

  it("exports the MINOR-unit integer beside its currency", async () => {
    // A spreadsheet dividing by 100 is wrong for a zero-decimal currency, so
    // the export ships the exact stored figure and lets the reader decide.
    const { svc } = makeService({
      rows: [
        {
          id: "p1", schoolId: "s1", reference: "SUB-1", plan: "ENTERPRISE", billingCycle: "TERM",
          kind: "RENEWAL", seats: 901, amountMinor: 320_981_250, currency: "NGN", status: "PAID",
          periodStart: null, periodEnd: null, paidAt: null, createdAt: new Date("2026-08-01T10:00:00Z"),
        },
      ],
      schools: [{ id: "s1", name: "St Andrews" }],
    });
    const { csv } = await svc.csv(OPERATOR, {});
    expect(csv).toContain(`"320981250","NGN"`);
  });
});
