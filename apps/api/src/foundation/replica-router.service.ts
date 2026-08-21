// =============================================================================
// Which database answers this read
// =============================================================================
// The read/write split routes 103 read paths to `DATABASE_REPLICA_URL` when one
// is set, and Terraform already provisions replicas and wires that variable into
// ECS. Nothing checked whether the replica had caught up. Demonstrated against a
// real streaming standby with replay paused:
//
//   teacher POSTs a leave request      201, committed on the primary
//   teacher GETs their own approvals   0 rows — their request is not there
//
// From the applicant's side the system lost their application, and the natural
// next action is to submit it again. That is the bug this service exists for.
//
// WHAT IT DOES, in the order the questions are worth asking:
//
//   1. No replica configured        → the primary, and none of the rest runs.
//   2. Replica lagging past the
//      threshold                    → the primary, for everybody, until it
//                                     catches up.
//   3. THIS user wrote recently and
//      the replica has not replayed
//      that far                     → the primary, for them alone.
//   4. Otherwise                    → the replica.
//
// (3) IS LSN-BASED, NOT TIME-BASED. "Send them to the primary for five seconds
// after a write" is the usual shortcut, and it is both too weak (a replica can
// lag for minutes) and too strong (it forfeits the replica when the standby is
// already caught up in 20 ms). A write records the primary's WAL position; a
// read compares it with the standby's replay position. That is exactly the
// question being asked, so it is right at both ends.
//
// THE LSN IS SHARED THROUGH REDIS, and that is not an optimisation. The write
// and the read that follows it are two HTTP requests and land on whichever ECS
// task the load balancer picks, so an in-process note would be consulted by the
// wrong instance most of the time. In-process is kept only as the degraded
// fallback for a single-instance deployment with no Redis.
//
// SESSION consistency, per user, deliberately. "Read your own writes" is the
// promise; "read everyone's writes instantly" is not, and would mean routing
// every read of a school to the primary for as long as anybody in it is typing —
// which is the whole read/write split undone.
// =============================================================================

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Redis, { type RedisOptions } from "ioredis";
import { prisma, readPrisma } from "@sms/db";

/**
 * How long after a write a user is still owed their own data.
 *
 * The window is a BACKSTOP, not the mechanism — the LSN comparison is what
 * releases somebody back to the replica, usually within milliseconds. This only
 * bounds how long a note survives if a replica never catches up, so a permanent
 * outage does not pin every user who ever wrote to the primary for ever.
 */
export const READ_AFTER_WRITE_WINDOW_SECONDS = 60;

/** Beyond this, the replica is not fit to answer anybody's read. */
export const REPLICA_LAG_THRESHOLD_SECONDS = Number(process.env.REPLICA_LAG_THRESHOLD_SECONDS ?? 5);

/** How often the standby is asked where it has got to. */
export const REPLICA_LAG_SAMPLE_MS = Number(process.env.REPLICA_LAG_SAMPLE_MS ?? 1000);

/**
 * Compare two `pg_lsn` values ("3/B5000060").
 *
 * Postgres would do this correctly with the `pg_lsn` type, but asking it would
 * cost a round trip on a path whose entire purpose is to avoid one. The format
 * is two hex halves; BigInt because the low half exceeds 2^32 and Number would
 * silently lose precision on a comparison that decides correctness.
 */
export function lsnToBigInt(lsn: string): bigint {
  const [hi, lo] = lsn.split("/");
  return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`);
}

export interface ReplicaState {
  /** Where the standby has replayed to, or null when it has not been asked yet. */
  replayLsn: string | null;
  /** Seconds between the primary's clock and the last transaction replayed. */
  lagSeconds: number | null;
  /** True when lag has passed the threshold and reads are going to the primary. */
  degraded: boolean;
  /** null when no standby is configured — the whole question is moot. */
  configured: boolean;
}

@Injectable()
export class ReplicaRouterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("ReplicaRouter");
  /** A replica is configured only if the read client is a DIFFERENT connection. */
  readonly configured = readPrisma !== prisma;
  private redis: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private replayLsn: bigint | null = null;
  /** The same position as Postgres writes it ("3/B5000060"), for humans. */
  private replayLsnText: string | null = null;
  private lagSeconds: number | null = null;
  private degraded = false;
  private warnedDegraded = false;
  /** Fallback when Redis is absent: correct on one instance, not across a fleet. */
  private readonly local = new Map<string, { lsn: bigint; at: number }>();

  /** Set by ObservabilityModule so routing decisions are visible on /metrics. */
  private observer: ((e: { primary: boolean; reason: string; lagSeconds: number | null }) => void) | null = null;

  onModuleInit(): void {
    if (!this.configured) {
      this.logger.log("No DATABASE_REPLICA_URL — every read is served by the primary.");
      return;
    }
    if (process.env.REDIS_PUBSUB_DISABLED !== "true") {
      const opts: RedisOptions = {
        host: process.env.REDIS_HOST ?? "127.0.0.1",
        port: Number(process.env.REDIS_PORT ?? 6379),
        ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
        ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
        maxRetriesPerRequest: null,
        retryStrategy: (times: number) => Math.min(times * 200, 5000),
      };
      try {
        this.redis = new Redis(opts);
        this.redis.on("error", (e: Error) => {
          if (!this.warnedDegraded) {
            this.warnedDegraded = true;
            this.logger.warn(
              `Redis unavailable — read-after-write falls back to per-instance memory, ` +
                `which is only correct on a single instance: ${e.message}`,
            );
          }
        });
      } catch {
        this.redis = null;
      }
    }
    void this.sample();
    this.timer = setInterval(() => void this.sample(), REPLICA_LAG_SAMPLE_MS);
    // Never hold the process open for a health sampler.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    void this.redis?.quit().catch(() => undefined);
  }

  setObserver(fn: (e: { primary: boolean; reason: string; lagSeconds: number | null }) => void): void {
    this.observer = fn;
  }

  /**
   * Ask the standby where it has got to.
   *
   * // GOTCHA, found by running this against a real standby rather than by
   * reasoning about it: `now() - pg_last_xact_replay_timestamp()` is NOT replica
   * lag. It is the time since the last transaction was replayed, which on an
   * IDLE PRIMARY grows without bound while the standby is byte-for-byte
   * identical. Measured here on a quiet local stack:
   *
   *   primary  pg_current_wal_lsn        3/B50F41D0
   *   standby  receive = replay          3/B50F41D0   (nothing outstanding)
   *   standby  since last transaction    14.0 s
   *
   * A 5-second threshold on that number marks a perfectly healthy replica
   * degraded and sends every read to the primary during exactly the quiet hours
   * the replica exists to help with — the feature disabling itself whenever it
   * is working.
   *
   * So: if everything RECEIVED has been REPLAYED there is nothing outstanding
   * and the lag is zero, whatever the clock says. The timestamp is used only
   * when replay is genuinely behind receive, which is when it means what its
   * name suggests.
   *
   * `pg_last_xact_replay_timestamp()` is also null on a standby that has
   * replayed nothing since it started; that is an idle primary, not an outage,
   * and reads zero. A standby that cannot be reached at all IS an outage, and
   * everything goes to the primary.
   */
  private async sample(): Promise<void> {
    try {
      const rows = (await readPrisma.$queryRawUnsafe(
        `SELECT pg_last_wal_replay_lsn()::text AS lsn,
                CASE WHEN pg_last_wal_receive_lsn() IS NOT DISTINCT FROM pg_last_wal_replay_lsn()
                     THEN 0::float8
                     ELSE EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8
                END AS lag,
                pg_is_in_recovery() AS standby`,
      )) as Array<{ lsn: string | null; lag: number | null; standby: boolean }>;
      const row = rows[0];
      if (!row?.standby) {
        // Pointed at something that is not a standby — a misconfiguration, or a
        // replica that has been promoted. Reads are still SAFE there, so this is
        // a warning and not a reroute.
        this.replayLsn = null;
        this.lagSeconds = 0;
        this.setDegraded(false, "read endpoint is not a standby");
        return;
      }
      this.replayLsn = row.lsn ? lsnToBigInt(row.lsn) : null;
      this.replayLsnText = row.lsn;
      this.lagSeconds = row.lag ?? 0;
      this.setDegraded(this.lagSeconds > REPLICA_LAG_THRESHOLD_SECONDS, `lag ${this.lagSeconds.toFixed(1)}s`);
    } catch (e) {
      // Unreachable standby: fail towards the primary, which is always correct
      // and merely more loaded.
      this.replayLsn = null;
      this.replayLsnText = null;
      this.lagSeconds = null;
      this.setDegraded(true, `unreachable: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  /** Log the EDGES only — a degraded replica must not write a line per second. */
  private setDegraded(next: boolean, why: string): void {
    if (next === this.degraded) return;
    this.degraded = next;
    if (next) this.logger.warn(`Replica unfit — routing ALL reads to the primary (${why}).`);
    else this.logger.log(`Replica caught up — reads routed to it again (${why}).`);
  }

  /**
   * Record that this user has just written, and how far the WAL had got.
   *
   * Called AFTER the transaction commits with `pg_current_wal_lsn()`, which is
   * at or past our own commit record. Deliberately conservative: waiting for a
   * position slightly beyond ours costs a few milliseconds on the replica, while
   * recording one slightly before ours would let exactly the stale read this
   * exists to prevent through.
   */
  async noteWrite(userId: string, lsn: string): Promise<void> {
    if (!this.configured) return;
    const value = lsnToBigInt(lsn);
    this.local.set(userId, { lsn: value, at: Date.now() });
    if (this.local.size > 10_000) this.pruneLocal();
    if (!this.redis) return;
    try {
      await this.redis.set(`raw:${userId}`, lsn, "EX", READ_AFTER_WRITE_WINDOW_SECONDS);
    } catch {
      /* the in-process note above still covers a single instance */
    }
  }

  /**
   * May this user's read be served by the replica?
   *
   * Ordered so the cheapest disqualifier runs first, and so the common case —
   * a healthy replica and a user who has not written — costs one Redis GET.
   */
  async useReplica(userId: string | null): Promise<{ replica: boolean; reason: string }> {
    if (!this.configured) return this.observed(false, "no replica configured");
    if (this.degraded) return this.observed(false, "replica lagging");
    if (!userId) return this.observed(true, "no user to be consistent with");
    const pending = await this.pendingLsn(userId);
    if (pending === null) return this.observed(true, "no recent write");
    if (this.replayLsn === null) return this.observed(false, "replica position unknown");
    if (this.replayLsn < pending) return this.observed(false, "replica has not replayed this user's write");
    // Caught up on this user's write: they are owed nothing further, and the
    // note is cleared so their next read does not pay for the lookup again.
    await this.clear(userId);
    return this.observed(true, "replica has replayed this user's write");
  }

  private observed(replica: boolean, reason: string): { replica: boolean; reason: string } {
    this.observer?.({ primary: !replica, reason, lagSeconds: this.lagSeconds });
    return { replica, reason };
  }

  private async pendingLsn(userId: string): Promise<bigint | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(`raw:${userId}`);
        if (v) return lsnToBigInt(v);
        // Redis is the shared truth; a miss means no pending write anywhere.
        return null;
      } catch {
        /* fall through to the in-process note */
      }
    }
    const hit = this.local.get(userId);
    if (!hit) return null;
    if (Date.now() - hit.at > READ_AFTER_WRITE_WINDOW_SECONDS * 1000) {
      this.local.delete(userId);
      return null;
    }
    return hit.lsn;
  }

  private async clear(userId: string): Promise<void> {
    this.local.delete(userId);
    if (!this.redis) return;
    try {
      await this.redis.del(`raw:${userId}`);
    } catch {
      /* the TTL removes it anyway */
    }
  }

  private pruneLocal(): void {
    const cutoff = Date.now() - READ_AFTER_WRITE_WINDOW_SECONDS * 1000;
    for (const [k, v] of this.local) if (v.at < cutoff) this.local.delete(k);
  }

  /** For /metrics, the operator console and the runbook. */
  state(): ReplicaState {
    return {
      replayLsn: this.replayLsnText,
      lagSeconds: this.lagSeconds,
      degraded: this.degraded,
      configured: this.configured,
    };
  }
}

/**
 * A router that has never been initialised, for code that constructs
 * `PrismaTenantService` directly — 38 places, all of them tests with no replica.
 *
 * Inert by construction rather than by convention: `configured` is
 * `readPrisma !== prisma`, which is false whenever no `DATABASE_REPLICA_URL` is
 * set, so every routing decision short-circuits to the primary and no sampler
 * ever starts. Nest still injects the real, initialised instance in the app.
 */
export const SINGLE_DATABASE_ROUTER = new ReplicaRouterService();
