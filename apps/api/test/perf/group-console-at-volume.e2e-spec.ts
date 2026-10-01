// =============================================================================
// The group console and the ledger check, timed at volume
// =============================================================================
// Not part of the ordinary run: it needs PERF_DATABASE_URL pointing at a
// database filled by scripts/seed-group-volume.sql (a throwaway copy — see the
// script's header). It drives the REAL service code, as the privileged role
// production uses, so what it times is what a director and the nightly job do.
//
// Median of five runs after one warm-up. Postgres caches a plan per prepared
// statement per connection, so the first call of each shape pays planning the
// later ones do not — the warm-up keeps a cold plan from being reported as the
// steady state, and the cold figure is printed separately because a director's
// FIRST page of the morning pays it.
//
// The ceilings asserted are generous on purpose: they catch an order-of-
// magnitude regression, not a 10% wobble on a laptop. The measured figures are
// recorded in the engineering log.
// =============================================================================

import { PrismaClient } from "@sms/db";
import { GROUP_PERIODS } from "@sms/types";
import { GroupService } from "../../src/group/group.service";
import { LedgerIntegrityService } from "../../src/fees/ledger-integrity.service";
import type { Principal } from "../../src/integrity/integrity.foundation";

const URL = process.env.PERF_DATABASE_URL;
const d = URL ? describe : describe.skip;

const GROUP_30 = "00000000-0000-4000-8000-000000000030";
const GROUP_10 = "00000000-0000-4000-8000-000000000010";

async function time<T>(fn: () => Promise<T>, runs = 5): Promise<{ cold: number; median: number; last: T }> {
  let t = performance.now();
  let last = await fn();
  const cold = performance.now() - t;
  const ms: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    t = performance.now();
    last = await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { cold: Math.round(cold), median: Math.round(ms[Math.floor(ms.length / 2)]), last };
}

d("group console at volume", () => {
  jest.setTimeout(600_000);
  let client: PrismaClient;
  let group: GroupService;
  let ledger: LedgerIntegrityService;
  let director: Principal;
  const results: string[] = [];

  beforeAll(async () => {
    client = new PrismaClient({ datasourceUrl: URL });
    const d1 = await client.schoolGroupDirector.findFirst({ where: { groupId: GROUP_30 }, select: { userId: true } });
    const u = await client.user.findFirst({ where: { id: d1!.userId }, select: { schoolId: true } });
    director = { schoolId: u!.schoolId, userId: d1!.userId, roles: ["principal"], permissions: [] };
    const db = { runAsTenant: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}) };
    const audit = { record: async () => undefined };
    group = new GroupService(db as never, audit as never, { client } as never, { isEnabled: async () => true } as never);
    ledger = new LedgerIntegrityService(db as never, audit as never, { client } as never, { enqueue: async () => undefined } as never);
  });

  afterAll(async () => {
    // eslint-disable-next-line no-console -- the measurements ARE the output
    console.log(`\n${results.join("\n")}\n`);
    await client.$disconnect();
  });

  it("checks it is measuring the fixture, not an empty database", async () => {
    const invoices = await client.invoice.count({ where: { reference: { startsWith: "VOLG-" } } });
    expect(invoices).toBeGreaterThan(100_000);
  });

  for (const [label, groupId, campuses] of [["10 campuses", GROUP_10, 10], ["30 campuses", GROUP_30, 30]] as const) {
    for (const { key } of GROUP_PERIODS) {
      it(`overview, ${label}, ${key}`, async () => {
        const r = await time(() => group.overview(director, { groupId, period: key }));
        expect(r.last.schools).toHaveLength(campuses);
        results.push(`overview  ${label.padEnd(11)} ${key.padEnd(6)} cold ${String(r.cold).padStart(6)} ms   median ${String(r.median).padStart(6)} ms`);
        expect(r.median).toBeLessThan(10_000);
      });
    }
  }

  it("campus page, this term", async () => {
    const ov = await group.overview(director, { groupId: GROUP_30, period: "term" });
    const r = await time(() => group.schoolDetail(director, ov.schools[0].schoolId, { period: "term" }));
    results.push(`campus page             term   cold ${String(r.cold).padStart(6)} ms   median ${String(r.median).padStart(6)} ms`);
    expect(r.median).toBeLessThan(10_000);
  });

  it("ledger integrity — the nightly sweep and the operator's first page", async () => {
    const sweep = await time(() => ledger.sweep("MANUAL"), 3);
    const list = await time(() => ledger.list(1), 3);
    results.push(`ledger sweep (fleet)           cold ${String(sweep.cold).padStart(6)} ms   median ${String(sweep.median).padStart(6)} ms   scanned ${sweep.last.scanned}`);
    results.push(`ledger list page 1             cold ${String(list.cold).padStart(6)} ms   median ${String(list.median).padStart(6)} ms`);
    // The fixture's ledger is consistent by construction.
    expect(sweep.last.mismatched).toBe(0);
    expect(sweep.median).toBeLessThan(60_000);
  });
});
