// =============================================================================
// An RLS file's "already applied" marker must be a policy only THAT FILE creates
// =============================================================================
// Production does not run `pnpm rls`. The API's docker-entrypoint.sh applies
// each prisma/rls/*.sql file ONLY IF a named policy — the file's marker — does
// not exist yet, so a new file lands on an initialised database without
// re-running the others.
//
// That is sound only if the marker can come from nowhere else. 08's marker was
// `attendance_record_update`, and migration 20270110000000_attendance_record_
// partition RE-DECLARES that policy when it partitions the table. On every FRESH
// database the migration runs first, the marker already exists, and the
// entrypoint skipped 08 entirely: `attendance_session` was left with RLS OFF, no
// policies and NO GRANTS for the app role — every register failing with
// "permission denied" on day one of a new production database. Found by
// rehearsing the production install path; CI never saw it because CI installs
// with the `pnpm rls` loop, which applied the top of 08 before erroring.
//
// The same collision broke `pnpm rls` itself: a bare CREATE POLICY of a name a
// migration already made stops the file at that line (ON_ERROR_STOP) and the
// loop carries on, exit 0. 02_foundation_rls.sql already DROP-then-CREATEs its
// audit_log policies for exactly this reason; 08 did not.
//
// Reads the real files: the entrypoint, every RLS file and every migration.
// =============================================================================
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(__dirname, "../../../..");
const rlsDir = join(repo, "packages/db/prisma/rls");
const migDir = join(repo, "packages/db/prisma/migrations");
const entrypoint = readFileSync(join(repo, "apps/api/docker-entrypoint.sh"), "utf8");

const rlsFiles = readdirSync(rlsDir).filter((f) => f.endsWith(".sql")).sort();
const rlsText = new Map(rlsFiles.map((f) => [f, readFileSync(join(rlsDir, f), "utf8")]));

// Comments stripped, so a policy NAMED in an explanation does not count.
const code = (sql: string) => sql.replace(/--[^\n]*/g, "");
/**
 * Every policy name a file creates — the literal ones AND the ones its loops
 * generate. Most RLS files create policies in a loop
 * (`FOREACH t IN ARRAY ARRAY['a','b'] LOOP … CREATE POLICY %1$s_select …`), so a
 * reader of literal names alone sees none of them: the first version of this
 * gate did exactly that and reported 33 correct files as wrong.
 */
const created = (sql: string): string[] => {
  const c = code(sql);
  const names = [...c.matchAll(/CREATE\s+POLICY\s+"?([a-z0-9_]+)"?/gi)].map((m) => m[1]);
  for (const loop of c.matchAll(/FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([^\]]*)\]\s+LOOP([\s\S]*?)END\s+LOOP/gi)) {
    const tables = [...loop[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    const ops = [...loop[2].matchAll(/CREATE\s+POLICY\s+%1\$s_([a-z_]+)/gi)].map((m) => m[1]);
    for (const t of tables) for (const op of ops) names.push(`${t}_${op}`);
  }
  return names;
};
const dropped = (sql: string) =>
  [...code(sql).matchAll(/DROP\s+POLICY\s+IF\s+EXISTS\s+"?([a-z0-9_]+)"?/gi)].map((m) => m[1]);

const migrationPolicies = new Set<string>();
for (const dir of readdirSync(migDir)) {
  let sql: string;
  try {
    sql = readFileSync(join(migDir, dir, "migration.sql"), "utf8");
  } catch {
    continue; // migration_lock.toml and similar
  }
  for (const name of created(sql)) migrationPolicies.add(name);
}

// `apply_rls packages/db/prisma/rls/<file>  <marker>`
const markers = new Map<string, string[]>();
for (const m of entrypoint.matchAll(/^apply_rls\s+packages\/db\/prisma\/rls\/(\S+)\s+(\S+)\s*$/gm)) {
  markers.set(m[1], [...(markers.get(m[1]) ?? []), m[2]]);
}

describe("RLS files and the production entrypoint", () => {
  it("found the files it is about (a walk that finds nothing must not pass)", () => {
    expect(rlsFiles.length).toBeGreaterThan(100);
    expect(markers.size).toBeGreaterThan(100);
    expect(migrationPolicies.size).toBeGreaterThan(0);
  });

  it("applies EVERY RLS file, exactly once", () => {
    const missing = rlsFiles.filter((f) => !markers.has(f));
    const twice = [...markers].filter(([, ms]) => ms.length > 1).map(([f]) => f);
    const stale = [...markers.keys()].filter((f) => !rlsText.has(f));
    expect({ missing, twice, stale }).toEqual({ missing: [], twice: [], stale: [] });
  });

  it("marks each file with a policy THAT FILE creates", () => {
    // A file that creates NO policies (91_fulltext_indexes.sql: indexes only)
    // has nothing to mark it by, so its marker never exists and it is re-applied
    // on every deploy. That is allowed ONLY if every statement is safe to re-run.
    // Stated as a rule rather than an exemption by file name.
    const wrong: string[] = [];
    for (const [f, [marker]] of markers) {
      const sql = rlsText.get(f);
      if (!sql) continue;
      const names = created(sql);
      if (names.includes(marker)) continue;
      if (names.length === 0) {
        const unsafe = [...code(sql).matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TABLE)\s+(?!IF\s+NOT\s+EXISTS)/gi)];
        if (unsafe.length === 0) continue; // re-applied each deploy, harmlessly
        wrong.push(`${f}: no policies, so re-applied on every deploy, but ${unsafe.length} statement(s) are not IF NOT EXISTS`);
        continue;
      }
      wrong.push(`${f}: marker ${marker} is not created by this file`);
    }
    expect(wrong).toEqual([]);
  });

  it("never marks a file with a policy a MIGRATION also creates", () => {
    // Such a marker exists on every fresh database before the file ever runs,
    // so the entrypoint skips the file there.
    const collide = [...markers]
      .filter(([, [marker]]) => migrationPolicies.has(marker))
      .map(([f, [marker]]) => `${f}: marker ${marker} is also created by a migration`);
    expect(collide).toEqual([]);
  });

  it("drops-if-exists any policy a migration also creates, before re-creating it", () => {
    // A bare CREATE of such a name errors on a fresh database and stops the
    // file there, leaving everything after it unapplied.
    const bare: string[] = [];
    for (const [f, sql] of rlsText) {
      const guarded = new Set(dropped(sql));
      for (const name of created(sql)) {
        if (migrationPolicies.has(name) && !guarded.has(name)) bare.push(`${f}: ${name}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
