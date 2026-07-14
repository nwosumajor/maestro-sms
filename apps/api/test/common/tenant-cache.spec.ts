// Unit: TenantCache<T> — read-through TTL cache + invalidation. Verifies a hit
// skips the loader, TTL expiry reloads, invalidate() drops + broadcasts, and a
// pub/sub invalidation message from another task drops the local entry.

import { TenantCache } from "../../src/common/tenant-cache";

describe("TenantCache", () => {
  afterEach(() => jest.useRealTimers());

  it("loads on miss and serves the cached value on a hit (no reload)", async () => {
    const cache = new TenantCache<number>("t", 60_000);
    let calls = 0;
    const load = async () => ++calls;
    expect(await cache.get("k", load)).toBe(1);
    expect(await cache.get("k", load)).toBe(1); // cached
    expect(calls).toBe(1);
  });

  it("keys are independent per tenant", async () => {
    const cache = new TenantCache<string>("t", 60_000);
    expect(await cache.get("a", async () => "A")).toBe("A");
    expect(await cache.get("b", async () => "B")).toBe("B");
    expect(await cache.get("a", async () => "A2")).toBe("A"); // still cached
  });

  it("reloads once the TTL has elapsed", async () => {
    jest.useFakeTimers();
    const cache = new TenantCache<number>("t", 1_000);
    let calls = 0;
    const load = async () => ++calls;
    expect(await cache.get("k", load)).toBe(1);
    jest.advanceTimersByTime(1_500); // past TTL
    expect(await cache.get("k", load)).toBe(2);
  });

  it("invalidate() drops the entry AND broadcasts on the cache's channel", async () => {
    const publish = jest.fn();
    const pubsub = { subscribe: jest.fn(), publish } as unknown as import("../../src/common/redis-pubsub.service").RedisPubSubService;
    const cache = new TenantCache<number>("branding-member", 60_000, pubsub);
    let calls = 0;
    await cache.get("k", async () => ++calls); // caches 1
    cache.invalidate("k");
    expect(publish).toHaveBeenCalledWith("cache:branding-member", { key: "k" });
    expect(await cache.get("k", async () => ++calls)).toBe(2); // reloaded after invalidation
  });

  it("drops a local entry when another task publishes an invalidation", async () => {
    let handler: ((p: unknown) => void) | undefined;
    const pubsub = {
      subscribe: (_ch: string, h: (p: unknown) => void) => { handler = h; },
      publish: jest.fn(),
    } as unknown as import("../../src/common/redis-pubsub.service").RedisPubSubService;
    const cache = new TenantCache<number>("t", 60_000, pubsub);
    let calls = 0;
    await cache.get("k", async () => ++calls); // 1, cached
    handler?.({ key: "k" }); // simulate a remote invalidation
    expect(await cache.get("k", async () => ++calls)).toBe(2); // reloaded
  });
});
