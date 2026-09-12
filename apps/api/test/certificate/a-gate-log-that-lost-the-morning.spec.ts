// =============================================================================
// 2,400 scans, 200 returned, and not one of them a check-in
// =============================================================================
// `GET /members/scan/today` promises, in its own docstring, "the day at the desk
// — EVERY scan", and says it answers "who is on the premises". It returned a
// bare array, `createdAt DESC`, capped at 200, with no count and no filter.
//
// Measured live on a 1,200-pupil school's ordinary day — check-ins through the
// morning, check-outs through the afternoon:
//
//     scans in the day    2,400   (1,200 of them check-ins)
//     returned              200
//     CHECK_INs returned      0   <- the question it exists to answer
//     time covered        15:48:21 .. 15:59:59   (11 minutes of a 9-hour day)
//     said there was more  nothing
//
// A newest-first cap on a day's movements discards the MORNING, and the morning
// is when everybody arrives. The desk could not say who was in the building.
//
// AND NO SCREEN CALLED IT. The route was permission-gated, audited, and reached
// from nowhere — `/scan` only ever did lookup-and-record. A capability with no
// door, whose cap would have bitten the moment anyone fitted one.
// =============================================================================

import { MemberScanService } from "../../src/certificate/member-scan.service";
import type { Principal, TenantContext, TenantTx } from "../../src/integrity/integrity.foundation";

const desk: Principal = {
  schoolId: "A", userId: "porter", roles: ["school_admin"],
  permissions: ["member.scan"],
};

const DAY_START = new Date();
DAY_START.setUTCHours(0, 0, 0, 0);

/** An ordinary day: 1,200 in through the morning, 1,200 out in the afternoon. */
const SCANS = Array.from({ length: 2400 }, (_, i) => {
  const morning = i % 2 === 0;
  return {
    id: `s-${String(i).padStart(4, "0")}`,
    memberId: `m-${i % 1200}`,
    scannedById: "porter",
    purpose: morning ? "CHECK_IN" : "CHECK_OUT",
    note: null,
    createdAt: new Date(DAY_START.getTime() + (morning ? 7 : 15) * 3_600_000 + (i * 7) % 3600 * 1000),
  };
});

function makeService(rows = SCANS) {
  const match = (where: Record<string, unknown> = {}) => {
    const purpose = where.purpose as string | undefined;
    return rows.filter((r) => (purpose ? r.purpose === purpose : true));
  };
  const tx = {
    scanEvent: {
      // HONOURS where, take AND skip. A double ignoring skip reports a pager
      // that works while every page serves the same rows.
      findMany: jest.fn(async ({ where, take, skip }: Record<string, never>) => {
        const out = [...match(where)].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
        );
        const from = (skip as number) ?? 0;
        return out.slice(from, from + ((take as number) ?? out.length));
      }),
      count: jest.fn(async ({ where }: Record<string, never>) => match(where).length),
      // Grouped over the WHOLE day — a double that honoured the page filter here
      // would vouch for counts that describe only what was shown.
      groupBy: jest.fn(async ({ where }: Record<string, never>) => {
        const by = new Map<string, number>();
        for (const r of match(where)) by.set(r.purpose, (by.get(r.purpose) ?? 0) + 1);
        return [...by].map(([purpose, n]) => ({ purpose, _count: { _all: n } }));
      }),
    },
    user: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => ({ id: "m-1" })) },
  } as unknown as TenantTx;

  const svc = new MemberScanService(
    {
      runAsTenant: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
      runAsTenantReadOnly: <T,>(_c: TenantContext, fn: (t: TenantTx) => Promise<T>) => fn(tx),
    } as never,
    { record: jest.fn() } as never,
    { forSchool: jest.fn(async () => ({ timezone: "Africa/Lagos" })), inTx: jest.fn(async () => ({ timezone: "Africa/Lagos" })) } as never,
  );
  return { svc, tx };
}

describe("the desk can say who is on the premises", () => {
  it("COUNTS the whole day, so the answer does not depend on the page", async () => {
    const { svc } = makeService();
    const d = await svc.today(desk);
    expect(d.counts.CHECK_IN).toBe(1200);
    expect(d.counts.CHECK_OUT).toBe(1200);
  });

  it("reports on-site as a FLOOR, never a negative number", async () => {
    // More check-outs than check-ins is normal (a pupil who arrived before the
    // desk opened), and a negative count on a safeguarding screen is worse than
    // an approximate one.
    const lopsided = SCANS.filter((s) => s.purpose === "CHECK_OUT").slice(0, 50);
    const d = await makeService(lopsided).svc.today(desk);
    expect(d.onSite).toBe(0);
  });

  it("says how many scans there were, not how many fit the page", async () => {
    const { svc } = makeService();
    const d = await svc.today(desk);
    expect(d.items.length).toBeLessThan(2400);
    expect(d.total).toBe(2400);
    expect(d.shown).toBe(d.items.length);
  });

  it("REACHES the morning check-ins — the rows that fell off the cap", async () => {
    const { svc } = makeService();
    const unfiltered = await svc.today(desk);
    // The defect, stated as a property: newest-first, the first page is all
    // afternoon, so check-ins are absent from it.
    expect(unfiltered.items.every((s) => s.purpose === "CHECK_OUT")).toBe(true);
    // And the filter is the way to them.
    const ins = await svc.today(desk, { purpose: "CHECK_IN" });
    expect(ins.total).toBe(1200);
    expect(ins.items.every((s) => s.purpose === "CHECK_IN")).toBe(true);
  });

  it("filters in the DATABASE, not over the page it already fetched", async () => {
    const { svc, tx } = makeService();
    await svc.today(desk, { purpose: "CHECK_IN" });
    const calls = (tx as unknown as { scanEvent: { findMany: jest.Mock } }).scanEvent.findMany.mock.calls;
    expect(JSON.stringify(calls[0][0].where)).toMatch(/CHECK_IN/);
  });

  it("counts the MATCHES when filtered, while the day's counts stay whole", async () => {
    const { svc } = makeService();
    const d = await svc.today(desk, { purpose: "CHECK_IN" });
    expect(d.total).toBe(1200);
    // The summary is about the DAY and must not narrow with the filter —
    // otherwise filtering to check-ins would report nobody having left.
    expect(d.counts.CHECK_OUT).toBe(1200);
  });

  it("pages to the rest of the day without repeating a row", async () => {
    const { svc } = makeService();
    const seen = new Set<string>();
    for (let page = 1; page <= 12; page += 1) {
      const d = await svc.today(desk, { page });
      for (const s of d.items) seen.add(s.id);
    }
    expect(seen.size).toBe(2400);
  });

  it("a quiet day is unchanged and complete", async () => {
    const d = await makeService(SCANS.slice(0, 12)).svc.today(desk);
    expect(d.total).toBe(12);
    expect(d.items).toHaveLength(12);
  });
});
