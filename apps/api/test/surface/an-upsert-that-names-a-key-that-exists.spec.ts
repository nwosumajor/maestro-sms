/**
 * Every raw ON CONFLICT target must name a unique key that actually exists.
 *
 * This is the gate for the defect that broke the ID-card scan desk. Its upsert
 * was written as a copy of the register's own, and when `attendance_record` was
 * RANGE-partitioned on `date` — which forces the partition key into every unique
 * constraint — the register's copy was updated and the scan desk's was not:
 *
 *     ON CONFLICT ("sessionId","studentId")     <- no such constraint any more
 *     42P10  there is no unique or exclusion constraint matching the
 *            ON CONFLICT specification
 *
 * Every student check-in was a 500, and because the statement runs inside
 * runAsTenant the scan_event and audit rows rolled back with it.
 *
 * NOTHING COULD SEE IT. The typechecker does not read SQL; the unit test stubs
 * `$executeRaw` with a `jest.fn()`, so it asserted "CHECK_IN marks a student
 * present" and stayed green. Only executing the statement against a real
 * partitioned table fails — and that is exactly what a fixture never does.
 *
 * So the pairing is checked HERE, against the Prisma schema rather than a live
 * database, so it runs in CI with no container: a migration that changes a
 * unique key now fails the build beside the raw SQL that depends on it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_DIR = join(__dirname, "../../../../packages/db/prisma/schema");
const SRC = join(__dirname, "../../src");

/** table name -> the column sets Postgres will accept as a conflict target. */
function declaredUniqueKeys(): Map<string, string[][]> {
  const byTable = new Map<string, string[][]>();
  for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith(".prisma"))) {
    const src = readFileSync(join(SCHEMA_DIR, f), "utf8");
    for (const m of src.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
      const body = m[2];
      const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? m[1];
      const keys: string[][] = [];
      for (const u of body.matchAll(/@@(?:unique|id)\(\[([^\]]+)\]/g)) {
        keys.push(u[1].split(",").map((s) => s.trim()));
      }
      // Field-level @unique / @id — a single-column target.
      for (const line of body.split("\n")) {
        const field = /^\s*(\w+)\s+\S+.*\s@(unique|id)\b/.exec(line);
        if (field) keys.push([field[1]]);
      }
      if (keys.length) byTable.set(table, keys);
    }
  }
  return byTable;
}

/** Every `INSERT INTO "t" … ON CONFLICT (cols)` in the API sources. */
function rawUpserts(): Array<{ file: string; table: string; target: string[] }> {
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  })(SRC);

  const found: Array<{ file: string; table: string; target: string[] }> = [];
  for (const f of files) {
    // Comments stripped first: this repo has twice had a gate fire on the prose
    // EXPLAINING the defect it exists for.
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const m of src.matchAll(
      /INSERT\s+INTO\s+"(\w+)"[\s\S]*?ON\s+CONFLICT\s*\(([^)]*)\)/gi,
    )) {
      const target = [...m[2].matchAll(/"(\w+)"/g)].map((c) => c[1]);
      if (target.length) found.push({ file: f.replace(SRC + "/", ""), table: m[1], target });
    }
  }
  return found;
}

const same = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

describe("an upsert that names a key that exists", () => {
  const keys = declaredUniqueKeys();
  const upserts = rawUpserts();

  it("found the schema and the statements", () => {
    // A walk that finds nothing produces no offenders and passes green while
    // covering nothing — `a-gate-must-not-pass-by-finding-nothing`.
    expect(keys.size).toBeGreaterThan(50);
    expect(upserts.length).toBeGreaterThan(0);
  });

  it("every conflict target matches a declared unique key on that table", () => {
    const bad: string[] = [];
    for (const u of upserts) {
      const declared = keys.get(u.table);
      if (!declared) {
        bad.push(`${u.file}: INSERT INTO "${u.table}" — no such model in the Prisma schema`);
        continue;
      }
      if (!declared.some((k) => same(k, u.target))) {
        bad.push(
          `${u.file}: ON CONFLICT (${u.target.join(", ")}) on "${u.table}" matches no unique key. ` +
            `Declared: ${declared.map((k) => `(${k.join(", ")})`).join(" ")}`,
        );
      }
    }
    expect(bad).toEqual([]);
  });

  it("a partitioned table's target carries its partition key", () => {
    // The specific rule that was violated: Postgres forces the partition key
    // into every unique constraint, so an upsert on attendance_record must name
    // `date` — in the conflict target AND in the column list, since it is NOT
    // NULL and is what routes the row to a partition.
    const records = upserts.filter((u) => u.table === "attendance_record");
    expect(records.length).toBeGreaterThanOrEqual(2); // the register and the scan desk
    for (const u of records) expect(u.target).toContain("date");
  });
});
