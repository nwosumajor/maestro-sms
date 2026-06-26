// =============================================================================
// Wire protocol for the standalone Elimination Ring server (spec §4, §11 step 6).
// =============================================================================
// JSON messages over WebSocket, parallel to the 2-player `protocol.ts`. Self-
// contained for the standalone transport; the SMS module (apps/api/src/game) owns
// the persisted, request-driven equivalent.
// SECURITY (spec §9): no server→client message ever carries a live secret — the
// only ring shape sent is the engine's redacted `RingView` (which also scopes the
// §4 inherited-history reward to the player who earned it).
// =============================================================================

import type { DeadWoundedResult, RingResult, RingView } from "@sms/game-engine";

/** Messages a client may send to the ring transport. */
export type RingClientMessage =
  | { type: "create"; difficultyLength?: number; displayName: string }
  | { type: "join"; ringId: string; displayName: string }
  // Only the creator (first player to join) may lock the roster and begin setup.
  | { type: "start" }
  | { type: "secret"; value: string }
  | { type: "guess"; value: string }
  | { type: "forfeit" };

/** Messages the ring transport sends. */
export type RingServerMessage =
  | { type: "joined"; ringId: string; playerId: string }
  | { type: "state"; ring: RingView }
  | { type: "scored"; result: DeadWoundedResult }
  // Fired once per turn as the turn clock runs low (spec §4: "a warning at 15
  // seconds remaining"). Advisory only — `playerId` is whose turn is expiring.
  | { type: "turn_warning"; playerId: string; remainingMs: number }
  | { type: "over"; winnerId: string; results: RingResult[] }
  | { type: "error"; code: string; message: string };

export const RING_CLIENT_MESSAGE_TYPES = [
  "create",
  "join",
  "start",
  "secret",
  "guess",
  "forfeit",
] as const;
