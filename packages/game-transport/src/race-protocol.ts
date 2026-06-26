// =============================================================================
// Wire protocol for the standalone Class Race server (spec §5, §11 step 5).
// =============================================================================
// JSON messages over WebSocket, parallel to `protocol.ts` / `ring-protocol.ts`.
// Self-contained for the standalone transport; the SMS module (apps/api/src/game)
// owns the persisted, request-driven equivalent.
// SECURITY (spec §9): no server→client message ever carries the shared target —
// the only race shape sent is the engine's redacted `RaceView` (which exposes
// only the viewer's own guesses and a finishers-only leaderboard).
// =============================================================================

import type { DeadWoundedResult, RaceResult, RaceView } from "@sms/game-engine";

/** Messages a client may send to the race transport. */
export type RaceClientMessage =
  | { type: "create"; difficultyLength?: number; displayName: string }
  | { type: "join"; raceId: string; displayName: string }
  // Only the host (the creator) may start the race or end it early.
  | { type: "start" }
  | { type: "end" }
  | { type: "guess"; value: string };

/** Messages the race transport sends. */
export type RaceServerMessage =
  | { type: "joined"; raceId: string; playerId: string }
  | { type: "state"; race: RaceView }
  | { type: "scored"; result: DeadWoundedResult }
  | { type: "over"; winnerId: string | null; results: RaceResult[] }
  | { type: "error"; code: string; message: string };

export const RACE_CLIENT_MESSAGE_TYPES = ["create", "join", "start", "end", "guess"] as const;
