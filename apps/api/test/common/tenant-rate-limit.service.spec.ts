// Unit: TenantRateLimitService — per-school fixed-window budget over Redis.
// Verifies allow-until-limit, per-tenant isolation (separate counters), and
// fail-OPEN when Redis errors. The Redis client is faked with an in-memory
// counter map so the Lua INCR semantics are reproduced without a real server.

import { TenantRateLimitService } from "../../src/common/tenant-rate-limit.service";

/** Fake ioredis: `eval` mimics the INCR+expire script over an in-memory map. */
function fakeRedis() {
  const counts = new Map<string, number>();
  return {
    counts,
    on: () => undefined,
    quit: async () => undefined,
    eval: async (_script: string, _numKeys: number, key: string) => {
      const c = (counts.get(key) ?? 0) + 1;
      counts.set(key, c);
      return c;
    },
  };
}

function makeService(fake: unknown, limit = 3): TenantRateLimitService {
  const svc = new TenantRateLimitService();
  // Inject the fake client + config that onModuleInit would have set.
  Object.assign(svc as unknown as Record<string, unknown>, {
    client: fake,
    enabled: true,
    limit,
    windowMs: 60_000,
  });
  return svc;
}

describe("TenantRateLimitService", () => {
  it("allows up to the limit then denies within a window", async () => {
    const svc = makeService(fakeRedis(), 3);
    const r1 = await svc.consume("school-a");
    const r2 = await svc.consume("school-a");
    const r3 = await svc.consume("school-a");
    const r4 = await svc.consume("school-a");
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r3.remaining).toBe(0);
    expect(r4.allowed).toBe(false); // 4th over a limit of 3
  });

  it("isolates tenants — one school's flood never spends another's budget", async () => {
    const svc = makeService(fakeRedis(), 2);
    await svc.consume("noisy"); // 1
    await svc.consume("noisy"); // 2
    const noisyOver = await svc.consume("noisy"); // 3 -> denied
    const quietFirst = await svc.consume("quiet"); // fresh budget
    expect(noisyOver.allowed).toBe(false);
    expect(quietFirst.allowed).toBe(true);
    expect(quietFirst.remaining).toBe(1);
  });

  it("fails OPEN when the Redis call throws (a limiter outage never blocks traffic)", async () => {
    const throwing = { on: () => undefined, quit: async () => undefined, eval: async () => { throw new Error("redis down"); } };
    const svc = makeService(throwing, 1);
    const r = await svc.consume("school-a");
    expect(r.allowed).toBe(true);
  });

  it("is a no-op (allows) when disabled / no client", async () => {
    const svc = new TenantRateLimitService(); // enabled=false, client=null
    const r = await svc.consume("school-a");
    expect(r.allowed).toBe(true);
  });
});
