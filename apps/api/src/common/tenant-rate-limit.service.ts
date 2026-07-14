// =============================================================================
// TenantRateLimitService — per-SCHOOL request rate limiting (scaling Phase 4)
// =============================================================================
// Noisy-neighbor protection at 5,000 tenants: one school's runaway traffic (a
// buggy integration, a scripted export loop, an attacker with a valid token)
// must not starve the API for the other 4,999. The existing RateLimitGuard is
// per-IP on the PUBLIC intake; this is complementary — a per-TENANT budget
// across every AUTHENTICATED request, keyed on the school_id from the verified
// JWT (never the body/query — Golden Rule #3).
//
// Redis-backed so the budget is SHARED across all ECS tasks (a fixed-window
// counter): the limit is the tenant's true aggregate, not per-task. Atomic
// INCR + expire-on-first via a tiny Lua script. Fixed window is intentional —
// cheap, one round-trip, and good enough for abuse control (a sliding log costs
// far more per request).
//
// FAIL-OPEN by design: if Redis is unreachable or disabled, requests are ALWAYS
// allowed — a limiter outage must never take down the whole API. The trade-off
// (a flood during a Redis outage) is strictly better than a self-inflicted
// global outage, and the edge WAF is the outer ceiling regardless.
// =============================================================================

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Redis, { type RedisOptions } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the current window resets. */
  resetMs: number;
}

// Atomic: increment the window counter and, on the FIRST hit, set its TTL so the
// window self-expires. Returns the new count. Keeps INCR and PEXPIRE from racing.
const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c
`;

@Injectable()
export class TenantRateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("TenantRateLimit");
  private client: Redis | null = null;
  private enabled = false;
  private warnedDown = false;

  private readonly windowMs = 60_000;
  /** Requests per school per minute. Generous — normal interactive use is well
   *  under this; it exists to cap pathological floods, not to shape traffic. */
  private readonly limit = Math.max(1, Number(process.env.TENANT_RATE_LIMIT_PER_MIN ?? 1200));

  onModuleInit(): void {
    if (process.env.TENANT_RATE_LIMIT_DISABLED === "true") {
      this.logger.warn("TENANT_RATE_LIMIT_DISABLED=true — per-tenant rate limiting OFF.");
      return;
    }
    const opts: RedisOptions = {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number(process.env.REDIS_PORT ?? 6379),
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
      // A transient Redis blip must never throw into the request path — reconnect
      // quietly and fail-open in the meantime.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    };
    try {
      this.client = new Redis(opts);
      this.client.on("error", (e) => {
        if (!this.warnedDown) {
          this.warnedDown = true;
          this.logger.warn(`Redis unavailable — rate limiting fails OPEN: ${e.message}`);
        }
      });
      this.client.on("ready", () => {
        this.warnedDown = false;
      });
      this.enabled = true;
      this.logger.log(`Per-tenant rate limiting ON: ${this.limit} req/min per school.`);
    } catch (e) {
      this.logger.warn(`Could not init rate-limit Redis — failing OPEN: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client?.quit();
    } catch {
      /* ignore */
    }
  }

  /**
   * Consume one unit of `schoolId`'s window budget. Returns whether the request
   * is allowed plus the headers' worth of context. Never throws — any Redis
   * error resolves to `allowed: true` (fail-open).
   */
  async consume(schoolId: string): Promise<RateLimitResult> {
    const base: RateLimitResult = { allowed: true, limit: this.limit, remaining: this.limit, resetMs: this.windowMs };
    if (!this.enabled || !this.client) return base;
    const bucket = Math.floor(Date.now() / this.windowMs);
    const key = `rl:tenant:${schoolId}:${bucket}`;
    try {
      const count = (await this.client.eval(INCR_SCRIPT, 1, key, String(this.windowMs))) as number;
      const remaining = Math.max(0, this.limit - count);
      const resetMs = this.windowMs - (Date.now() % this.windowMs);
      return { allowed: count <= this.limit, limit: this.limit, remaining, resetMs };
    } catch (e) {
      // Fail-open: a limiter error must never block a request.
      if (!this.warnedDown) {
        this.warnedDown = true;
        this.logger.warn(`Rate-limit check failed — allowing (fail-open): ${(e as Error).message}`);
      }
      return base;
    }
  }
}
