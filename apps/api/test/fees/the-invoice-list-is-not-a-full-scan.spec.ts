// =============================================================================
// The finance invoice list read every invoice the school had ever raised
// =============================================================================
// `listInvoices` pages with `ORDER BY "createdAt" DESC, id DESC LIMIT n`. Nothing
// served that order, so Postgres scanned the whole table and top-N sorted it.
// Correct, and O(the school's LIFETIME invoice count) on every page load — the
// shape that is fine for a year and slow in five, because it grows with how long
// a school has been on the platform rather than with how big the school is.
//
// Measured as the APPLICATION role with RLS in force (never as postgres, which
// bypasses row security and gets a different plan), on 45,000 invoices across
// 2,001 pupils in a scratch database:
//
//   default finance page   40.1 ms, 986 buffers  ->  0.10 ms, 4 buffers
//   with a status filter   38.1 ms, 980 buffers  ->  0.19 ms, 52 buffers
//   a parent's own list     0.28 ms (already indexed by (schoolId, studentId))
//
// ONE index, not two. A `(schoolId, status, createdAt DESC, id DESC)` variant was
// built and measured alongside and the planner NEVER chose it — not even for a
// status matching 200 of 45,000 rows, where it should have won. An index nothing
// selects is storage and write amplification on a hot table for nothing, which is
// exactly what the three trigram indexes dropped in 20261228000000 were.
//
// This test pins the PROPERTY rather than the name: an index rooted at schoolId
// that carries createdAt. Renaming it is fine; dropping it is not.
// =============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = readFileSync(join(__dirname, "../../../../packages/db/prisma/schema/fees.prisma"), "utf8");
const MIGRATIONS = join(__dirname, "../../../../packages/db/prisma/migrations");

function model(name: string): string {
  const m = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(SCHEMA);
  if (!m) throw new Error(`no model ${name}`);
  return m[0];
}

describe("the index behind the paged invoice list", () => {
  it("is declared on Invoice, rooted at schoolId and carrying createdAt", () => {
    const indexes = [...model("Invoice").matchAll(/@@index\(\[([^\]]+)\]/g)].map((m) => m[1]);
    const serving = indexes.filter((i) => /^schoolId/.test(i.trim()) && /createdAt/.test(i));
    expect(serving.length).toBeGreaterThan(0);
  });

  it("orders createdAt DESC, matching the query's own ORDER BY", () => {
    // A plain ascending index would still work — btrees read backwards — but
    // this one also serves the keyset cursor the pager walks.
    const indexes = [...model("Invoice").matchAll(/@@index\(\[([^\]]+)\]/g)].map((m) => m[1]);
    expect(indexes.some((i) => /createdAt\(sort: Desc\)/.test(i))).toBe(true);
  });

  it("has a migration, so an existing database gets it too", () => {
    // The schema alone changes nothing on a deployed database.
    const dirs = readdirSync(MIGRATIONS).filter((d) => d.includes("invoice_list_index"));
    expect(dirs).toHaveLength(1);
    const sql = readFileSync(join(MIGRATIONS, dirs[0], "migration.sql"), "utf8");
    expect(sql).toMatch(/CREATE INDEX[\s\S]*"invoice"[\s\S]*"schoolId"[\s\S]*"createdAt" DESC/);
  });

  it("does NOT also create the status variant the planner would not use", () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => d.includes("invoice_list_index"));
    const sql = readFileSync(join(MIGRATIONS, dirs[0], "migration.sql"), "utf8");
    const statements = sql.split("\n").filter((l) => /^CREATE INDEX/.test(l.trim()));
    expect(statements).toHaveLength(1);
  });

  it("still keeps the per-student index a family's own list uses", () => {
    // The parent path measured 0.28 ms and must not be traded away.
    const indexes = [...model("Invoice").matchAll(/@@index\(\[([^\]]+)\]/g)].map((m) => m[1]);
    expect(indexes.some((i) => /schoolId,\s*studentId/.test(i))).toBe(true);
  });
});
