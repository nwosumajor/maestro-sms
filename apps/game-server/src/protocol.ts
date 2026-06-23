// =============================================================================
// Wire protocol for the standalone 2-player game server (spec §11 step 2).
// =============================================================================
// JSON messages over WebSocket. Self-contained for the standalone step; when the
// game is folded into the SMS (step 3) these can move into `@sms/types`.
// SECURITY (spec §9): no server→client message ever carries a live secret — the
// only game shape sent is the engine's redacted `DuelView`.
// =============================================================================

import type { DeadWoundedResult, DuelView, PlayerResult } from "@sms/game-engine";

/** Messages a client may send. */
export type ClientMessage =
  | { type: "create"; difficultyLength: number; displayName: string }
  | { type: "join"; gameId: string; displayName: string }
  | { type: "secret"; value: string }
  | { type: "guess"; value: string }
  | { type: "forfeit" };

/** Messages the server sends. */
export type ServerMessage =
  | { type: "joined"; gameId: string; playerId: string }
  | { type: "state"; game: DuelView }
  | { type: "scored"; result: DeadWoundedResult }
  | { type: "over"; winnerId: string; results: PlayerResult[] }
  | { type: "error"; code: string; message: string };

export const CLIENT_MESSAGE_TYPES = ["create", "join", "secret", "guess", "forfeit"] as const;
