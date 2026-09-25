// =============================================================================
// SharedCacheService — a value every API task sees, and a lock only one holds
// =============================================================================
// Production runs at least two API tasks behind the load balancer (auto-scaling
// to ten). A value cached in process memory is therefore a value PER TASK, and
// two reloads landing on different tasks can disagree — for a dashboard that
// prints "as of", the time can even go BACKWARDS after a refresh. This keeps the
// value in Redis instead, so every task serves the same copy, and offers a short
// lock so only one task recomputes at a time.
//
// FAILS FAST, NEVER WAITS. Every method THROWS promptly when Redis is down,
// disconnected or slow, so the caller falls back to its own process-local
// behaviour. The pub/sub connection in RedisPubSubService deliberately waits
// through outages (`maxRetriesPerRequest: null`); reused here, a Redis outage
// would turn "the cache is unavailable" into "the dashboard hangs". Hence its
// own connection, configured like the rate limiter's: one retry, no offline
// queue, and a per-command timeout for a Redis that is up but not answering.
//
// Values are opaque strings; callers serialise. Carries no tenant data by
// itself — what a caller stores is its own responsibility.
// =============================================================================

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import Redis, { type RedisOptions } from "ioredis";
import { envOr } from "./env";

/** Delete the lock only if WE still hold it — a lock that expired and was taken
 *  by another task must not be released by the task that lost it. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;

@Injectable()
export class SharedCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("SharedCache");
  private client: Redis | null = null;
  private warnedDown = false;

  onModuleInit(): void {
    if (process.env.SHARED_CACHE_DISABLED === "true") {
      this.logger.warn("SHARED_CACHE_DISABLED=true — shared cache OFF (callers use process-local copies).");
      return;
    }
    const opts: RedisOptions = {
      host: envOr("REDIS_HOST", "127.0.0.1"),
      port: Number(envOr("REDIS_PORT", "6379")),
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 1_000,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    };
    try {
      this.client = new Redis(opts);
      this.client.on("error", (e: Error) => {
        if (!this.warnedDown) {
          this.warnedDown = true;
          this.logger.warn(`Redis unavailable — shared cache falls back to process-local copies: ${e.message}`);
        }
      });
      this.client.on("ready", () => {
        this.warnedDown = false;
      });
    } catch (e) {
      this.logger.warn(`Shared cache init failed — process-local fallback: ${(e as Error).message}`);
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client?.quit();
    } catch {
      /* ignore */
    }
  }

  /** Whether there is a connection worth trying. A false here means callers
   *  should go straight to their local path rather than wait on an error. */
  get available(): boolean {
    return this.client !== null && this.client.status === "ready";
  }

  private need(): Redis {
    if (!this.client || this.client.status !== "ready") throw new Error("shared cache unavailable");
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.need().get(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.need().set(key, value, "PX", ttlMs);
  }

  /** Take a lock for `ttlMs`, or return null if another task holds it. The TTL
   *  bounds how long a task that DIES while holding it can block the others. */
  async tryLock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.need().set(key, token, "PX", ttlMs, "NX");
    return ok === "OK" ? token : null;
  }

  async unlock(key: string, token: string): Promise<void> {
    await this.need().eval(RELEASE_SCRIPT, 1, key, token);
  }

  async isLocked(key: string): Promise<boolean> {
    return (await this.need().exists(key)) === 1;
  }
}
