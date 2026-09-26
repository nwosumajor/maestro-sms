// =============================================================================
// GrantAbsenceCache — remembers that a user holds NO elevation grant
// =============================================================================
// The PermissionGuard merges a user's active JIT grants into their permissions
// on EVERY authenticated request, and that read is a transaction of its own
// (BEGIN, two GUCs, the SELECT, COMMIT). Almost nobody holds a grant — they are
// rare, bounded, and expire — so on almost every request the transaction
// answers "none", and it was among the largest per-request costs under load.
//
// ONLY THE NEGATIVE ANSWER IS CACHED, and that choice is the whole design:
//   - A user who HOLDS a grant is read from the database on every request, so a
//     REVOKE or an expiry takes effect on their very next request, exactly as
//     before. Nothing here can extend what somebody may do.
//   - The only thing this can do wrong is make a NEW grant late, which denies —
//     the safe direction. It is kept short: every activation clears the cache
//     on THIS task at once and on every other task over Redis pub/sub, and
//     `GRANT_ABSENCE_TTL_MS` bounds the delay when Redis is down.
//
// THE RACE, and why there is an epoch: a request that read "none" just BEFORE a
// grant committed could store that answer just AFTER the activation cleared the
// cache, hiding the new grant for a full TTL. The caller takes `epoch()` before
// its read and `rememberNone` refuses to store if any clear happened since.
// Clears are global rather than per user because activations are rare: wiping
// every entry costs one re-read per active user, once.
// =============================================================================

import { Injectable, OnModuleInit, Optional } from "@nestjs/common";
import { RedisPubSubService } from "../common/redis-pubsub.service";

/** How long "holds no grant" is believed with no activation heard. Bounds how
 *  late a new grant can be honoured on another task when pub/sub is down. */
export const GRANT_ABSENCE_TTL_MS = 30_000;
/** Bounded so a fleet's worth of users cannot grow memory without limit. */
export const GRANT_ABSENCE_MAX_ENTRIES = 50_000;
const CLEAR_CHANNEL = "grants:activated";

@Injectable()
export class GrantAbsenceCache implements OnModuleInit {
  private readonly none = new Map<string, number>(); // key -> stored at (ms)
  private generation = 0;

  constructor(@Optional() private readonly pubsub?: RedisPubSubService) {}

  onModuleInit(): void {
    this.pubsub?.subscribe(CLEAR_CHANNEL, () => this.clearLocal());
  }

  private key(schoolId: string, userId: string): string {
    return `${schoolId}:${userId}`;
  }

  /** Take BEFORE reading the database; hand back to `rememberNone`. */
  epoch(): number {
    return this.generation;
  }

  /** True when this user is known, recently, to hold no active grant. */
  knownToHoldNone(schoolId: string, userId: string, now = Date.now()): boolean {
    const k = this.key(schoolId, userId);
    const at = this.none.get(k);
    if (at === undefined) return false;
    if (now - at >= GRANT_ABSENCE_TTL_MS) {
      this.none.delete(k);
      return false;
    }
    return true;
  }

  /** Record "holds none" — unless a grant was activated since `epoch` was taken. */
  rememberNone(schoolId: string, userId: string, epoch: number, now = Date.now()): void {
    if (epoch !== this.generation) return;
    const k = this.key(schoolId, userId);
    this.none.delete(k); // re-insert at the end: Map order is insertion order
    if (this.none.size >= GRANT_ABSENCE_MAX_ENTRIES) {
      const oldest = this.none.keys().next().value;
      if (oldest !== undefined) this.none.delete(oldest);
    }
    this.none.set(k, now);
  }

  /** A grant became ACTIVE somewhere: forget every "holds none", here and on
   *  every other task. Call AFTER the activating transaction commits. */
  granted(): void {
    this.clearLocal();
    this.pubsub?.publish(CLEAR_CHANNEL, {});
  }

  private clearLocal(): void {
    this.generation++;
    this.none.clear();
  }
}
