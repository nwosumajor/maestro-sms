import { Injectable } from "@nestjs/common";
import { EventEmitter } from "node:events";

// =============================================================================
// GameEventsService — in-process "a game changed" pub/sub (spec §10 real-time).
// =============================================================================
// The durable GameService stays the SOLE authority (Postgres + RLS + audit). When
// a mutation commits it announces the affected gameId here; the WebSocket gateway
// (GameSocketGateway) is the ONLY subscriber and re-reads the RLS-scoped, viewer-
// redacted view to push to connected clients. This carries NO game data and NO
// authority — just a gameId nudge — so it can never become a second source of
// truth or leak across tenants (the re-read enforces both).
//
// Process-local by design: a live socket session is transient (§10). A multi-
// instance deployment would swap this for Redis pub/sub behind the same two
// methods; nothing else changes.
// =============================================================================

@Injectable()
export class GameEventsService {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many concurrent sockets may subscribe; lift the default 10-listener cap.
    this.emitter.setMaxListeners(0);
  }

  /** Announce that `gameId` changed (called AFTER the mutation transaction commits). */
  emitChanged(gameId: string): void {
    this.emitter.emit("changed", gameId);
  }

  /** Subscribe to all game changes. Returns an unsubscribe function. */
  onChanged(listener: (gameId: string) => void): () => void {
    this.emitter.on("changed", listener);
    return () => this.emitter.off("changed", listener);
  }
}
