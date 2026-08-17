// =============================================================================
// The space VACUUM cannot give back
// =============================================================================
// The platform deletes a great deal on purpose — retention clears telemetry,
// read notifications, finished-game guesses, gateway events and old content
// revisions — and the money tables update repeatedly as an invoice moves
// DRAFT → ISSUED → PARTIALLY_PAID → PAID. Every one of those writes a new index
// tuple and leaves the old one dead.
//
// VACUUM reclaims the HEAP. It does not shrink a btree: freed pages are kept for
// that index to reuse and are never returned to the filesystem, so an index that
// has seen churn stays at its high-water mark for ever. Nothing here ever
// reindexed — so the very mechanism that keeps the tables small was leaving
// their indexes growing without bound.
//
// Measured on a real database rather than argued:
//
//     attendance_record_sessionId_studentId_key   409 MB  ->  8.4 MB
//
// and on the same database `message_credit_entry` held 18 live rows behind
// 285 MB of indexes after 2.7 million deletes.
// =============================================================================

import {
  INDEX_BLOAT_MAX_PER_RUN,
  INDEX_BLOAT_MIN_BYTES,
  INDEX_BLOAT_RATIO,
  IndexBloatService,
} from "../../src/maintenance/index-bloat.service";

const MB = 1024 * 1024;

type Row = Record<string, unknown>;

function makeService(opts: {
  invalid?: Array<{ schemaname: string; indexname: string }>;
  candidates?: Array<{ indexname: string; tablename: string; idxBytes: number }>;
  afterBytes?: number;
  noDb?: boolean;
  failOn?: string;
} = {}) {
  const statements: string[] = [];
  const client = {
    $queryRawUnsafe: jest.fn(async (sql: string, ..._args: unknown[]): Promise<Row[]> => {
      if (sql.includes("indisvalid") && sql.includes("NOT i.indisvalid")) return opts.invalid ?? [];
      if (sql.includes("pg_stat_user_indexes")) {
        return (opts.candidates ?? []).map((c) => ({
          schemaname: "public",
          indexname: c.indexname,
          tablename: c.tablename,
          idxBytes: BigInt(c.idxBytes),
        }));
      }
      if (sql.includes("pg_relation_size($1::regclass)")) {
        return [{ bytes: BigInt(opts.afterBytes ?? 8 * MB) }];
      }
      return [];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      statements.push(sql);
      if (opts.failOn && sql.includes(opts.failOn)) throw new Error("lock timeout");
      return 1;
    }),
  };
  const db = { client: opts.noDb ? null : client };
  return { service: new IndexBloatService(db as never), statements, client };
}

const bloated = (name: string, mb: number) => ({ indexname: name, tablename: "attendance_record", idxBytes: mb * MB });

describe("reclaiming a bloated index", () => {
  it("rebuilds it CONCURRENTLY, so nobody is locked out of the table", async () => {
    // A blocking REINDEX on a 400MB index would take the register offline for
    // minutes. Concurrently is the whole reason this can run at all.
    const { service, statements } = makeService({ candidates: [bloated("att_idx", 409)] });
    await service.reclaim();
    expect(statements.some((s) => /REINDEX INDEX CONCURRENTLY "public"\."att_idx"/.test(s))).toBe(true);
  });

  it("reports the bytes actually handed back", async () => {
    const { service } = makeService({ candidates: [bloated("att_idx", 409)], afterBytes: 8 * MB });
    const r = await service.reclaim();
    expect(r.reindexed).toBe(1);
    expect(r.bytesReclaimed).toBe(401 * MB);
  });

  it("never reports a negative reclaim when an index grows back", async () => {
    // Rebuilding can legitimately end larger if the table grew meanwhile; that
    // is not a gain of negative space.
    const { service } = makeService({ candidates: [bloated("att_idx", 40)], afterBytes: 50 * MB });
    const r = await service.reclaim();
    expect(r.bytesReclaimed).toBe(0);
  });

  it("does a bounded amount of work and says what it left", async () => {
    // A neglected database catches up over several weeks rather than spending
    // one night rewriting everything it owns.
    const many = Array.from({ length: INDEX_BLOAT_MAX_PER_RUN + 4 }, (_, i) => bloated(`idx_${i}`, 100));
    const { service } = makeService({ candidates: many });
    const r = await service.reclaim();
    expect(r.reindexed).toBe(INDEX_BLOAT_MAX_PER_RUN);
    expect(r.remaining).toBe(4);
  });

  it("carries on when one index cannot be rebuilt", async () => {
    const { service } = makeService({ candidates: [bloated("bad_idx", 100), bloated("good_idx", 90)], failOn: "bad_idx" });
    const r = await service.reclaim();
    expect(r.reindexed).toBe(1);
    expect(r.details[0].index).toBe("good_idx");
  });
});

describe("what it refuses to touch", () => {
  it("asks the database for large AND disproportionate indexes only", async () => {
    // Reindexing a healthy index costs real time and temporary disk and gives
    // nothing back, so the selection happens in SQL rather than by rebuilding
    // everything and seeing.
    const { service, client } = makeService({ candidates: [] });
    await service.reclaim();
    const call = (client.$queryRawUnsafe as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes("pg_stat_user_indexes"),
    );
    expect(String(call?.[0])).toMatch(/pg_relation_size\(s\.indexrelid\) >= \$1/);
    expect(String(call?.[0])).toMatch(/> \$2 \* \(pg_table_size\(s\.relid\)/);
    expect(call?.[1]).toBe(INDEX_BLOAT_MIN_BYTES);
    expect(call?.[2]).toBe(INDEX_BLOAT_RATIO);
  });

  it("only considers VALID indexes as candidates", async () => {
    // An invalid one is dropped, not rebuilt — rebuilding it would keep rubbish
    // alive.
    const { service, client } = makeService({ candidates: [] });
    await service.reclaim();
    const call = (client.$queryRawUnsafe as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes("pg_stat_user_indexes"),
    );
    expect(String(call?.[0])).toMatch(/i\.indisvalid/);
  });

  it("does nothing at all when nothing qualifies", async () => {
    const { service, statements } = makeService({ candidates: [] });
    const r = await service.reclaim();
    expect(r).toMatchObject({ reindexed: 0, bytesReclaimed: 0, remaining: 0 });
    expect(statements).toEqual([]);
  });
});

describe("leftovers from an interrupted run", () => {
  it("drops the invalid index a failed concurrent reindex leaves behind", async () => {
    // `_ccnew` is maintained on every write to the table and used by nothing.
    // Left alone it is pure cost, and it accumulates one per failed attempt.
    const { service, statements } = makeService({
      invalid: [{ schemaname: "public", indexname: "att_idx_ccnew" }],
      candidates: [],
    });
    const r = await service.reclaim();
    expect(r.invalidDropped).toBe(1);
    expect(statements[0]).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS "public"\."att_idx_ccnew"/);
  });

  it("sweeps them BEFORE measuring, so the measurements are not confused by them", async () => {
    const { service, client } = makeService({
      invalid: [{ schemaname: "public", indexname: "x_ccnew" }],
      candidates: [bloated("att_idx", 100)],
    });
    await service.reclaim();
    const calls = (client.$queryRawUnsafe as jest.Mock).mock.calls.map((c) => String(c[0]));
    const invalidAt = calls.findIndex((s) => s.includes("NOT i.indisvalid"));
    const candidatesAt = calls.findIndex((s) => s.includes("pg_stat_user_indexes"));
    expect(invalidAt).toBeLessThan(candidatesAt);
  });

  it("keeps going when one cannot be dropped", async () => {
    const { service } = makeService({
      invalid: [{ schemaname: "public", indexname: "a_ccnew" }, { schemaname: "public", indexname: "b_ccnew" }],
      candidates: [],
      failOn: "a_ccnew",
    });
    const r = await service.reclaim();
    expect(r.invalidDropped).toBe(1);
  });
});

describe("the sweep's own honesty", () => {
  it("reports that it could not run, rather than reporting nothing to do", async () => {
    const { service } = makeService({ noDb: true });
    const r = await service.reclaim();
    expect(r.skipped).toBe("NO_DB");
  });
});
