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
  noClient?: boolean;
}) {
  const groupBy = jest.fn().mockResolvedValue(opts.grouped ?? []);
  const findMany = jest.fn().mockResolvedValue(opts.rows ?? []);
  const count = jest.fn().mockResolvedValue((opts.rows ?? []).length);
  const schoolFindMany = jest.fn().mockResolvedValue(opts.schools ?? []);
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
          },
    },
  });
  return { svc, groupBy, findMany, count, schoolFindMany, audit };
}

const paid = (currency: string, sum: number, n: number) => ({
  currency,
  status: "PAID",
  _sum: { amountMinor: sum },
  _count: { _all: n },
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
