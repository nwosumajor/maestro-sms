// Which Prisma models has the test suite ever actually WRITTEN to?
//
// Run `pnpm --filter @sms/api write-coverage` with TEST_DATABASE_URL and
// TEST_ADMIN_URL set. Everything on the "never" list is a table whose column
// set no test has ever put in front of Prisma: the arithmetic may be checked by
// a mocked upsert while the write itself cannot execute. That is not
// hypothetical — the gradebook's most-used write was rejected outright by
// Prisma for months, and SubjectResult was on this list.
//
// This is a MEASUREMENT, not a gate. It is not wired into CI: a hard threshold
// here would be noise, and the useful question is which of these matter.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Prisma } = require("@sms/db");

let lines = "";
try {
  lines = readFileSync(process.env.WRITE_COVERAGE_OUT || "/tmp/write-coverage.txt", "utf8");
} catch {
  console.error("No recording found — did the suite run with WRITE_COVERAGE=1?");
  process.exit(1);
}

const written = new Set(
  lines
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t")[0]),
);
const all = Prisma.dmmf.datamodel.models.map((m) => m.name);
const never = all.filter((m) => !written.has(m)).sort();

console.log(`models: ${all.length}`);
console.log(`written by some test against a real database: ${written.size}`);
console.log(`NEVER written: ${never.length}\n`);
console.log(never.join("\n"));
