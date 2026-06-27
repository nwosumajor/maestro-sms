// =============================================================================
// RedisPubSubService — cross-instance fan-out for process-local signals
// =============================================================================
// Some in-process signals must reach EVERY API task, not just the one that
// produced them, once we run more than one replica (ECS Fargate):
//   - entitlement-cache invalidation (a billing webhook / operator write on ONE
//     task must drop the stale plan on ALL tasks), and
//   - "a game changed" live-push nudges (the durable mutation lands on one task;
//     spectators may be connected to another).
//
// This is a thin, GENERIC publish/subscribe over Redis. It carries NO authority
// and NO tenant data beyond an opaque id — consumers re-read RLS-scoped state, so
// a stray message can never leak across tenants. Each instance stamps its own id
// on what it publishes and SKIPS its own echoes, so the producer delivers locally
// (directly, synchronously) and remote tasks deliver via Redis — exactly once
// each. Reuses the same Redis connection config as BullMQ.
//
// Least-privilege / graceful default: if Redis is unreachable or pub/sub is
// disabled, publish/subscribe become no-ops and every service falls back to its
// existing PROCESS-LOCAL behaviour — never a crash. (Redis is already required
// for BullMQ in this deployment, so this is normally always on.)
// =============================================================================

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import Redis, { type RedisOptions } from "ioredis";

type Handler = (payload: unknown) => void;

interface Envelope {
  /** Publishing instance id — used to skip our own echoes. */
  src: string;
  payload: unknown;
}

@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("RedisPubSub");
  /** Unique per process — lets us ignore the copy of our own message Redis echoes back. */
  private readonly instanceId = randomUUID();
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly loggedErrors = new Set<string>();
  private enabled = false;

  onModuleInit(): void {
    if (process.env.REDIS_PUBSUB_DISABLED === "true") {
      this.logger.warn("REDIS_PUBSUB_DISABLED=true — cross-instance pub/sub OFF (process-local only).");
      return;
    }
    const opts: RedisOptions = {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number(process.env.REDIS_PORT ?? 6379),
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
      ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
      // Never let a transient outage throw into a request path; reconnect quietly.
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
      lazyConnect: false,
    };
    try {
      this.publisher = new Redis(opts);
      this.subscriber = new Redis(opts);
      this.publisher.on("error", (e: Error) => this.onError("publisher", e));
      this.subscriber.on("error", (e: Error) => this.onError("subscriber", e));
      this.subscriber.on("message", (channel: string, message: string) => this.dispatch(channel, message));
      // Any channels registered before init (consumers subscribe in their own
      // onModuleInit, which runs AFTER ours since they depend on us) are covered;
      // re-subscribe defensively in case subscribe() ran first.
      for (const channel of this.handlers.keys()) void this.subscriber.subscribe(channel);
      this.enabled = true;
      this.logger.log("Redis pub/sub initialised (cross-instance cache + live nudges).");
    } catch (e) {
      this.logger.warn(`Redis pub/sub init failed — process-local fallback: ${(e as Error).message}`);
      this.publisher = null;
      this.subscriber = null;
    }
  }

  private onError(which: string, e: Error): void {
    // Log once per connection — ioredis auto-reconnects and would otherwise spam.
    if (!this.loggedErrors.has(which)) {
      this.loggedErrors.add(which);
      this.logger.warn(`Redis ${which} error (auto-reconnecting): ${e.message}`);
    }
  }

  /** Fan a payload out to OTHER instances. Local delivery is the caller's job. */
  publish(channel: string, payload: unknown): void {
    if (!this.enabled || !this.publisher) return;
    const envelope: Envelope = { src: this.instanceId, payload };
    void this.publisher.publish(channel, JSON.stringify(envelope)).catch(() => {});
  }

  /** Register a handler for REMOTE messages on a channel (skips our own echoes). */
  subscribe(channel: string, handler: Handler): void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      this.subscriber?.subscribe(channel).catch((e) =>
        this.logger.warn(`subscribe ${channel} failed: ${(e as Error).message}`),
      );
    }
    set.add(handler);
  }

  private dispatch(channel: string, message: string): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    let env: Envelope;
    try {
      env = JSON.parse(message) as Envelope;
    } catch {
      return;
    }
    if (env.src === this.instanceId) return; // our own echo — already handled locally
    for (const h of set) {
      try {
        h(env.payload);
      } catch (e) {
        this.logger.warn(`pub/sub handler for ${channel} threw: ${(e as Error).message}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.publisher?.quit().catch(() => undefined);
    await this.subscriber?.quit().catch(() => undefined);
  }
}
