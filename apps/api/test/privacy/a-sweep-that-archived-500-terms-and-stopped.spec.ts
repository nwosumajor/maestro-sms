// =============================================================================
// A nightly sweep that archived 500 terms once and then never another
// =============================================================================
// `archiveEndedTerms` selected the OLDEST 500 ended terms, then filtered the
// already-archived ones out IN MEMORY. So once the first 500 were archived it
// took the same 500 every night, skipped all of them, and never reached term
// 501.
//
// Measured on a 5,000-school fleet with 15,600 ended terms due:
//
//   run 1: archived=500 skipped=0   backlog=15103
//   run 2: archived=0   skipped=500 backlog=15103
//   runs 3-7: identical — archived=0, every night, for ever
//
// 15,100 terms would never be archived: the statutory record a school is told it
// can still produce in ten years.
//
// It survived because that line reads like health. "Nothing archived, everything
// already archived" is exactly what a caught-up sweep looks like, and `lastOk`
// was true with `failed: 0` throughout. The BACKLOG counter added for the
// notification sweep is what made it visible — frozen at 15,103 for six
// consecutive runs, which is precisely the diagnosis that counter exists to
// give. After: 500 archived every night and the backlog falling 14,600 ->
// 14,100 -> 13,600 -> ... exactly 500 a night.
// =============================================================================

import { SchoolArchiveService } from "../../src/privacy/archive.service";

type Term = { id: string; schoolId: string; name: string; sessionId: string; endDate: Date; startDate: Date | null };

function harness(opts: { terms: Term[]; archivedTermIds: string[] }) {
  const archived = new Set(opts.archivedTermIds);
  const created: string[] = [];

  /**
   * HONOURS THE ANTI-JOIN THE SQL ASKS FOR. A double that always excluded
   * archived terms would pass against a service that had stopped excluding them
   * — which is exactly the defect. It applies the exclusion only when the query
   * actually contains it.
   */
  const runSql = (sql: string) => {
    const excludes = /NOT EXISTS[\s\S]*school_archive[\s\S]*"termId"/.test(sql);
    const due = opts.terms.filter((t) => t.endDate && (!excludes || !archived.has(t.id)));
    return due.sort((a, b) => a.endDate.getTime() - b.endDate.getTime());
  };

  const client = {
    $queryRaw: jest.fn(async (q: { strings?: string[]; sql?: string }) => {
      const sql = (q?.strings ?? []).join(" ") + (q?.sql ?? "");
      const due = runSql(sql);
      if (/count\(\*\)/.test(sql)) return [{ n: due.length }];
      return due.slice(0, 500);
    }),
    schoolArchive: {
      findMany: jest.fn(async ({ where }: { where: { termId: { in: string[] } } }) =>
        where.termId.in.filter((id) => archived.has(id)).map((termId) => ({ termId })),
      ),
    },
  };

  const svc = new SchoolArchiveService(
    { runAsTenant: async <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({}),
      runAsTenantReadOnly: async <T>(_c: unknown, fn: (t: unknown) => Promise<T>) => fn({}) } as never,
    { record: jest.fn() } as never,
    { upload: jest.fn(), presignDownload: jest.fn() } as never,
    { client } as never,
  );
  // `create` is exercised by its own suite; here the question is WHICH terms the
  // sweep reaches, so it is stubbed to record and mark archived.
  jest.spyOn(svc, "create").mockImplementation((async (_p: unknown, input: { termId?: string }) => {
    created.push(input.termId!);
    archived.add(input.termId!);
    return { id: "a", label: "l", sizeBytes: 1, checksum: "c", sections: {}, containsHrPii: false, createdAt: new Date(), scope: null };
  }) as never);
  return { svc, created, archived, client };
}

const manyTerms = (n: number): Term[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, schoolId: `s${i % 50}`, name: `Term ${i}`, sessionId: `sess${i}`,
    endDate: new Date(Date.now() - (n - i) * 86_400_000), startDate: new Date(Date.now() - (n - i + 90) * 86_400_000),
  }));

describe("the nightly term sweep", () => {
  it("ADVANCES — a second run archives the NEXT batch, not the same one", async () => {
    const { svc, created } = harness({ terms: manyTerms(1200), archivedTermIds: [] });
    const first = await svc.archiveEndedTerms("SCHEDULED");
    const firstBatch = [...created];
    const second = await svc.archiveEndedTerms("SCHEDULED");
    expect(first.archived).toBe(500);
    expect(second.archived).toBe(500); // was 0 — the defect
    // And they are DIFFERENT terms.
    expect(created.slice(500).some((id) => firstBatch.includes(id))).toBe(false);
  });

  it("drains: the backlog FALLS by a batch each run", async () => {
    const { svc } = harness({ terms: manyTerms(1200), archivedTermIds: [] });
    const a = await svc.archiveEndedTerms("SCHEDULED");
    const b = await svc.archiveEndedTerms("SCHEDULED");
    const c = await svc.archiveEndedTerms("SCHEDULED");
    expect(a.backlog).toBe(700);
    expect(b.backlog).toBe(200);
    expect(c.backlog).toBe(0);
  });

  it("reaches the LAST term, not just the first batch", async () => {
    const { svc, created } = harness({ terms: manyTerms(1200), archivedTermIds: [] });
    for (let i = 0; i < 3; i++) await svc.archiveEndedTerms("SCHEDULED");
    expect(created).toHaveLength(1200);
    expect(created).toContain("t1199");
  });

  it("still never re-archives a term it already has", async () => {
    // The idempotence the unique constraint guarantees, kept: excluding them in
    // the query must not become "archive them again".
    const { svc } = harness({ terms: manyTerms(10), archivedTermIds: ["t0", "t1", "t2"] });
    const r = await svc.archiveEndedTerms("SCHEDULED");
    expect(r.archived).toBe(7);
  });

  it("says so when nothing is due, rather than reporting a phantom backlog", async () => {
    const { svc } = harness({ terms: manyTerms(4), archivedTermIds: ["t0", "t1", "t2", "t3"] });
    const r = await svc.archiveEndedTerms("SCHEDULED");
    expect(r.archived).toBe(0);
    expect(r.backlog).toBe(0);
  });
});
