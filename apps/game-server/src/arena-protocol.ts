// =============================================================================
// Wire protocol for the standalone Ultimate ARENA server (spec §7, §11 step 8).
// =============================================================================
// JSON messages over WebSocket, parallel to the other modes' protocols. This is
// the GOVERNANCE-FREE arena transport: it carries only handles + scores (exactly
// what spec §7 lets cross the tenant boundary). The SMS service
// (apps/api/src/game/ultimate.service.ts) owns the cross-school consent /
// enrollment / userId↔participantId bridge — none of which touches this surface.
// SECURITY (spec §9): no server→client message ever carries a per-entry target —
// the only arena shape sent is the engine's redacted `ArenaView`.
// =============================================================================

import type { ArenaResult, ArenaView, DeadWoundedResult } from "@sms/game-engine";

/** Messages a client may send to the arena transport. */
export type ArenaClientMessage =
  // Admin opens an arena (does not enter it as a player).
  | { type: "create"; difficultyLength?: number }
  // A player enters with a HANDLE (never a real name); their get-ready countdown
  // starts, then their own clock begins.
  | { type: "enter"; arenaId: string; handle: string }
  | { type: "guess"; value: string }
  // Admin closes the arena (final standings are published).
  | { type: "close" };

/** Messages the arena transport sends. */
export type ArenaServerMessage =
  | { type: "created"; arenaId: string }
  | { type: "entered"; arenaId: string; participantId: string }
  // Get-ready countdown before this player's clock starts (spec §10). When it
  // elapses the server begins the race and a fresh `state` follows.
  | { type: "countdown"; remainingMs: number }
  | { type: "state"; arena: ArenaView }
  | { type: "scored"; result: DeadWoundedResult }
  | { type: "over"; results: ArenaResult[] }
  | { type: "error"; code: string; message: string };

export const ARENA_CLIENT_MESSAGE_TYPES = ["create", "enter", "guess", "close"] as const;
