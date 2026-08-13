// Records which Prisma models a test run actually WRITES to against a real
// database. Opt-in via WRITE_COVERAGE=1; does nothing otherwise.
//
// The point: a mocked write proves the arithmetic and says nothing about whether
// Prisma would accept the object. A model with no real write anywhere in the
// suite is a table whose column set has never been checked by anything.
const fs = require("node:fs");

if (process.env.WRITE_COVERAGE === "1") {
  const OUT = process.env.WRITE_COVERAGE_OUT || "/tmp/write-coverage.txt";
  try {
    const { prisma } = require("@sms/db");
    prisma.$use(async (params, next) => {
      const result = await next(params);
      if (/^(create|update|upsert|createMany|updateMany|delete|deleteMany)$/.test(params.action)) {
        try {
          fs.appendFileSync(OUT, `${params.model}\t${params.action}\n`);
        } catch {
          /* recording must never break a test */
        }
      }
      return result;
    });
  } catch {
    /* @sms/db not resolvable in this worker — nothing to record */
  }
}
