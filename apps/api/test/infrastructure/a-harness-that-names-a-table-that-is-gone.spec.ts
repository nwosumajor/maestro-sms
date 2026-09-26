// =============================================================================
// A test harness that writes raw SQL must name tables that still exist
// =============================================================================
// `scripts/loadtest.mjs` seeds synthetic schools with raw SQL, so nothing
// type-checks it against the schema, and nothing in CI runs it. `class_teacher`
// was retired on 2026-08-30 ("one column for one class teacher"); the harness
// went on inserting into it, and the pre-production rehearsal found the load test
// dead on arrival a month later — and, because it cleaned up only after a
// COMPLETED seed, it left 30 schools and 3,060 users behind in the dev database.
//
// The harness that measures capacity is the one piece of tooling nobody runs
// until they need a number, which is the worst moment to find it broken. This
// reads the SQL inside every query string of the API's scripts and fails on any
// table the Prisma schema does not map.
// =============================================================================
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(__dirname, "../../../..");
const schemaDir = join(repo, "packages/db/prisma/schema");
const scriptsDir = join(repo, "apps/api/scripts");

const tables = new Set<string>();
for (const f of readdirSync(schemaDir).filter((f) => f.endsWith(".prisma"))) {
  for (const m of readFileSync(join(schemaDir, f), "utf8").matchAll(/@@map\("([a-z0-9_]+)"\)/g)) tables.add(m[1]);
}

/** SQL lives in template literals; comments are stripped so an explanation that
 *  NAMES a retired table (as this repo's comments do) cannot trip the gate. */
function sqlIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return [...code.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}

// Not tables: Postgres catalogs and set-returning functions a query may name.
const notATable = (name: string) => name.startsWith("pg_") || name === "information_schema" || name === "generate_series";

describe("raw SQL in the API's scripts", () => {
  const scripts = readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs"));
  const refs: Array<{ script: string; table: string }> = [];
  for (const script of scripts) {
    for (const sql of sqlIn(readFileSync(join(scriptsDir, script), "utf8"))) {
      for (const m of sql.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|FROM|JOIN)\s+"?([a-z][a-z0-9_]*)"?/g)) {
        if (!notATable(m[1])) refs.push({ script, table: m[1] });
      }
    }
  }

  it("found the schema and the queries it is about (a walk that finds nothing must not pass)", () => {
    expect(tables.size).toBeGreaterThan(150);
    expect(refs.some((r) => r.script === "loadtest.mjs")).toBe(true);
  });

  it("names only tables the schema still has", () => {
    const gone = refs.filter((r) => !tables.has(r.table)).map((r) => `${r.script}: ${r.table}`);
    expect([...new Set(gone)]).toEqual([]);
  });
});
