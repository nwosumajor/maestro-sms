// =============================================================================
// A green tick over a quarter of the suite that never ran
// =============================================================================
// 30 suites gate themselves on the test database:
//
//   const d = APP_URL && ADMIN_URL ? describe : describe.skip;
//
// Without the variables they SKIP — deliberately, so `jest` works with no
// Postgres. What that produces is a PASS with a quiet "427 skipped" line, and
// among those 427 is `rls.e2e-spec.ts`, which this project calls the most
// important test category there is.
//
// CLAUDE.md already records what that costs: CI sat red for three days, 0 of 71
// runs, on three tests that no local run could have shown. It also quotes
// figures ("3,619 tests and SKIPS 28 suites (396 tests)") that had drifted from
// the truth by the time I read them — because a count typed into prose rots the
// moment a suite is added.
//
// So this says it out loud on every bare run, and DERIVES the numbers rather
// than restating them. It asserts nothing about the database: with the variables
// set it is silent, and it never fails a legitimate no-Postgres run.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const TEST_ROOT = join(__dirname);

/** Suites that gate themselves on the test database. */
function dbGatedSuites(dir: string = TEST_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...dbGatedSuites(p));
      // JEST'S OWN PATTERN, not a hand-written suffix.
      //
      // // GOTCHA, and this gate's magnitude assertion is what caught it:
      // `"rls.e2e-spec.ts".endsWith(".spec.ts")` is FALSE — the separator is a
      // HYPHEN. Filtering on `.spec.ts` missed all 30 e2e suites, which are
      // precisely the database-gated ones this exists to count. It found 3.
    } else if (/\.(spec|e2e-spec)\.ts$/.test(entry)) {
      const src = readFileSync(p, "utf8");
      if (/process\.env\.TEST_DATABASE_URL/.test(src) && /describe\.skip/.test(src)) {
        out.push(p.replace(`${TEST_ROOT}/`, ""));
      }
    }
  }
  return out;
}

describe("a green run that skipped a quarter of itself", () => {
  const gated = dbGatedSuites();

  it("found the DB-gated suites it exists to count", () => {
    // A walk that finds nothing would print nothing and pass — the failure this
    // repo names in a-gate-must-not-pass-by-finding-nothing.
    expect(gated.length).toBeGreaterThanOrEqual(20);
  });

  it("says so when they are not going to run", () => {
    const configured = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_ADMIN_URL);
    if (!configured) {
      // Loud, on every bare invocation, naming the command that runs them.
      // eslint-disable-next-line no-console -- reason: telling the runner what it did not do is the point
      console.warn(
        `\n${"=".repeat(72)}\n` +
          `  ${gated.length} SUITES WERE SKIPPED, including rls.e2e-spec.ts.\n` +
          `  TEST_DATABASE_URL / TEST_ADMIN_URL are not set, so every database-backed\n` +
          `  test — cross-tenant isolation among them — was NOT RUN. This run being\n` +
          `  green says nothing about them.\n\n` +
          `      pnpm --filter @sms/api test:db\n\n` +
          `  runs the whole suite against the sms-test-pg container.\n` +
          `${"=".repeat(72)}\n`,
      );
    }
    // Never fails: a no-Postgres run is legitimate. The point is that it cannot
    // be MISTAKEN for a full one.
    expect(gated.length).toBeGreaterThan(0);
  });
});
