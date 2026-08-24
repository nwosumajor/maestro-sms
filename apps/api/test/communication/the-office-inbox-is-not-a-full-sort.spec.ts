// =============================================================================
// The staff inbox sorted every thread the school had ever opened
// =============================================================================
// `listThreads` pages with `ORDER BY "createdAt" DESC, id DESC LIMIT n` over the
// threads the caller participates in, and `message_thread` had only a `schoolId`
// index — nothing served that order.
//
// THE PLAN DEPENDS ON HOW MANY THREADS THE CALLER IS IN, and only one of the two
// cases was bad. Measured as the APPLICATION role with RLS in force, on 100,000
// threads in one school:
//
//   a user in 50 of them      0.63 ms   participant-driven nested loop, already fine
//   the OFFICE account, in
//   every single thread      66.06 ms   Parallel Seq Scan of all 100,000 plus an
//                                       external merge sort SPILLING 2.5 MB to disk
//
// The second is not a corner case. A general-enquiries, bursar or school-office
// account IS in every conversation, and nothing archives threads — so that
// inbox's page cost grows with the school's entire messaging history, for ever.
// It is the O(lifetime) shape again, wearing a different hat: it looked fine on
// the development database precisely because 2,601 threads is small enough that
// a sequential scan is genuinely the cheaper plan.
//
// After the index:
//
//   the OFFICE account        0.38 ms   walks it newest-first, stops at the limit,
//                                       no sort and no spill   (172x)
//   a user in 50              0.60 ms   UNCHANGED — the planner keeps the
//                                       participant-driven plan
//
// BOTH extremes were measured, because an index that fixes one shape by dragging
// the planner off a good plan for the other is not an improvement. The sparse
// case pays nothing.
//
// // GOTCHA while measuring: the sparse case first read 9.7 ms AFTER the index,
// which looked like exactly that regression. It was bloat from the bulk UPDATE
// used to build the fixture — 1,399 buffers to fetch 50 rows. VACUUM, re-measure,
// 0.60 ms. A benchmark has to account for the churn the benchmark itself caused.
// =============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = readFileSync(join(__dirname, "../../../../packages/db/prisma/schema/messaging.prisma"), "utf8");
const MIGRATIONS = join(__dirname, "../../../../packages/db/prisma/migrations");

function model(name: string): string {
  const m = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(SCHEMA);
  if (!m) throw new Error(`no model ${name}`);
  return m[0];
}

const indexesOf = (name: string) => [...model(name).matchAll(/@@index\(\[([^\]]+)\]/g)].map((m) => m[1]);

describe("the index behind the paged thread list", () => {
  it("is declared on MessageThread, rooted at schoolId and carrying createdAt", () => {
    const serving = indexesOf("MessageThread").filter((i) => /^schoolId/.test(i.trim()) && /createdAt/.test(i));
    expect(serving.length).toBeGreaterThan(0);
  });

  it("orders createdAt DESC, matching the query's own ORDER BY and its cursor", () => {
    expect(indexesOf("MessageThread").some((i) => /createdAt\(sort: Desc\)/.test(i))).toBe(true);
  });

  it("has a migration, so an existing database gets it too", () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => d.includes("thread_list_index"));
    expect(dirs).toHaveLength(1);
    const sql = readFileSync(join(MIGRATIONS, dirs[0], "migration.sql"), "utf8");
    expect(sql).toMatch(/CREATE INDEX[\s\S]*"message_thread"[\s\S]*"schoolId"[\s\S]*"createdAt" DESC/);
  });

  it("adds exactly one index, not a speculative family of them", () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => d.includes("thread_list_index"));
    const sql = readFileSync(join(MIGRATIONS, dirs[0], "migration.sql"), "utf8");
    expect(sql.split("\n").filter((l) => /^CREATE INDEX/.test(l.trim()))).toHaveLength(1);
  });

  it("keeps the participant index the sparse case depends on", () => {
    // The other half of the measurement: a user in few threads is served by
    // (schoolId, userId) on thread_participant, and must stay that way.
    expect(indexesOf("ThreadParticipant").some((i) => /schoolId,\s*userId/.test(i))).toBe(true);
  });
});
