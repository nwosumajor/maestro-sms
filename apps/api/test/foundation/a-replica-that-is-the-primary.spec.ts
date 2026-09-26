// =============================================================================
// A replica that is the primary opened a second pool against the primary
// =============================================================================
// Terraform gave every single-database deployment DATABASE_REPLICA_URL = the
// primary's URL, and `@sms/db` opened a separate client for any non-empty value.
// Each API task therefore held TWO pools against one database — doubling what
// the connection budget has to fit — and the replica router, which decides
// "is there a replica?" by `readPrisma !== prisma`, ran a lag probe every second
// and an extra query per write for a replica that did not exist.
// These load the REAL module under each environment: a test of `replicaUrlOf`
// alone would not show that the client uses it.
// =============================================================================

type Db = typeof import("@sms/db");

function load(env: Record<string, string | undefined>): Db {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  delete (globalThis as { prisma?: unknown; readPrisma?: unknown }).prisma;
  delete (globalThis as { prisma?: unknown; readPrisma?: unknown }).readPrisma;
  let mod!: Db;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("@sms/db") as Db;
  });
  process.env = saved;
  return mod;
}

const PRIMARY = "postgresql://app:pw@primary.example:5432/sms?connection_limit=8&pool_timeout=10";
const REPLICA = "postgresql://app:pw@replica.example:5432/sms?connection_limit=8&pool_timeout=10";

describe("the read client", () => {
  it("is the primary client when the replica URL IS the primary's", () => {
    const db = load({ DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: PRIMARY });
    expect(db.readPrisma).toBe(db.prisma);
  });

  it("is the primary client when no replica is set, or it is empty", () => {
    for (const v of [undefined, "", "   "]) {
      const db = load({ DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: v });
      expect(db.readPrisma).toBe(db.prisma);
    }
  });

  it("is a SEPARATE client for a real replica", () => {
    const db = load({ DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
    expect(db.readPrisma).not.toBe(db.prisma);
  });
});
