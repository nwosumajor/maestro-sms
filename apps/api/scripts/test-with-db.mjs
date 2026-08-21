#!/usr/bin/env node
/**
 * Run the API suite against the local test database — all of it.
 *
 * A bare `jest` runs 3,619 tests and SKIPS 28 suites (396 tests), because every
 * DB-gated spec `describe.skip`s without `TEST_DATABASE_URL`. That skip is
 * deliberate and right for somebody without a database. What it is not is
 * visible: CI supplies those variables and runs 4,015 tests, so a perfectly
 * green local run said nothing at all about a quarter of the suite. CI was red
 * for three days on three of those tests and no local run could have shown it.
 *
 * The variables were also easy to get wrong one at a time. `TEST_DATABASE_URL`
 * and `TEST_ADMIN_URL` feed the raw-pool RLS spec; `DATABASE_URL` is needed
 * because the Prisma-backed service e2es go through the @sms/db singleton; and
 * `AUTH_SECRET` is needed because the storage stub signs URLs with it — without
 * it the report-card vault write fails, is SWALLOWED by a best-effort catch, and
 * the test fails on a status two assertions later.
 *
 * Reads the credentials from infrastructure/.env so there is nothing to
 * remember and nothing to paste into a shell history.
 *
 *   pnpm --filter @sms/api test:db            # everything
 *   pnpm --filter @sms/api test:db test/fees  # a subset, args pass through
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const envFile = join(repo, "infrastructure", ".env");

/** The test container from docker-compose; 5434 so it never collides with dev. */
const HOST = process.env.TEST_PG_HOST ?? "localhost";
const PORT = process.env.TEST_PG_PORT ?? "5434";
const DB = process.env.TEST_PG_DB ?? "sms_test";

function fromEnvFile(key) {
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

const appPassword = process.env.APP_DB_PASSWORD ?? fromEnvFile("APP_DB_PASSWORD");
if (!appPassword) {
  console.error(
    `Could not read APP_DB_PASSWORD from ${envFile}.\n` +
      `Set it, or export APP_DB_PASSWORD, or run the plain \`jest\` and accept that\n` +
      `28 suites will skip.`,
  );
  process.exit(1);
}

const appUrl = `postgresql://major_user:${appPassword}@${HOST}:${PORT}/${DB}`;
const env = {
  ...process.env,
  TEST_DATABASE_URL: appUrl,
  TEST_ADMIN_URL: process.env.TEST_ADMIN_URL ?? `postgresql://postgres:postgres@${HOST}:${PORT}/${DB}`,
  // The Prisma singleton the service e2es use.
  DATABASE_URL: appUrl,
  // The storage stub signs presigned URLs with this; CI uses a dummy too.
  AUTH_SECRET: process.env.AUTH_SECRET ?? fromEnvFile("AUTH_SECRET") ?? "local-test-secret",
  DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY ?? fromEnvFile("DATA_ENCRYPTION_KEY") ?? "",
};

// --runInBand: these suites share one database and set per-tenant GUCs; running
// them in parallel workers interleaves their fixtures.
const args = ["jest", "--runInBand", ...process.argv.slice(2)];
console.log(`test:db → ${HOST}:${PORT}/${DB} (all suites; a bare jest skips 28)`);
const res = spawnSync("pnpm", ["exec", ...args], { stdio: "inherit", env, cwd: join(here, "..") });
process.exit(res.status ?? 1);
