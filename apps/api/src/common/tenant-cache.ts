// =============================================================================
// TenantCache<T> — per-key read-through cache with cross-instance invalidation
// =============================================================================
// The reusable form of the pattern proven by ModuleEntitlementService (scaling
// Phase 6): a small process-local TTL cache in front of a hot, rarely-changing
// per-tenant reference read, with a Redis pub/sub broadcast so a WRITE on one
// ECS task drops the stale copy on ALL tasks.
//
// Use it for reference data read on many requests and written seldom (branding /
// theme, per-school game settings, feature config). Do NOT use it for
// authorization/scoping data (enrollment, roles, grants) — staleness there is a
// security concern; those must stay uncached or reload per request.
//
// Correctness notes for callers:
//   - Cache the DB-DERIVED data, not values with their own lifetime (e.g. a
//     presigned URL) — recompute those OUTSIDE the cache so they never go stale.
//   - Always pair a write with invalidate(key). Even without it the entry
//     self-heals within ttlMs, but invalidation makes changes immediate.
//   - Graceful default: with no RedisPubSubService (or Redis down) this is a
//     plain per-process TTL cache — correct, just not cross-instance-immediate.
// =============================================================================

import type { RedisPubSubService } from "./redis-pubsub.service";

interface Entry<T> {
  at: number;
  value: T;
}

export class TenantCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  private readonly channel: string;

  constructor(
    /** Distinct name → its own invalidation channel (e.g. "branding-member"). */
    name: string,
    private readonly ttlMs: number,
    private readonly pubsub?: RedisPubSubService,
  ) {
    this.channel = `cache:${name}`;
    // A write on another task publishes {key}; drop our copy so we reload fresh.
    this.pubsub?.subscribe(this.channel, (payload) => {
      const key = (payload as { key?: string })?.key;
      if (key) this.store.delete(key);
    });
  }

  /** Return the cached value for `key`, or run `load()`, cache, and return it. */
  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await load();
    this.store.set(key, { at: Date.now(), value });
    // Bound memory under pathological key churn (many tenants): evict the oldest
    // once the map grows large. TTL makes stale entries harmless meanwhile.
    if (this.store.size > 10_000) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    return value;
  }

  /** Drop `key` here AND on every other task (call after a write to that key). */
  invalidate(key: string): void {
    this.store.delete(key);
    this.pubsub?.publish(this.channel, { key });
  }
}
