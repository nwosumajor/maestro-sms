import { Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { RedisPubSubService } from "../common/redis-pubsub.service";

// =============================================================================
// GameEventsService — "a game changed" pub/sub (spec §10 real-time).
// =============================================================================
// The durable GameService stays the SOLE authority (Postgres + RLS + audit). When
// a mutation commits it announces the affected gameId here; the WebSocket gateway
// (GameSocketGateway) is the ONLY subscriber and re-reads the RLS-scoped, viewer-
// redacted view to push to connected clients. This carries NO game data and NO
// authority — just a gameId nudge — so it can never become a second source of
// truth or leak across tenants (the re-read enforces both).
//
// Cross-instance: in a multi-replica deployment a spectator may be connected to a
// DIFFERENT task than the one that committed the mutation. We fan the nudge out
// over Redis (RedisPubSubService) behind these same two methods — the producer
// delivers to its OWN local subscribers directly, remote tasks deliver via Redis.
// When Redis is absent the service degrades to the original process-local
// EventEmitter; nothing else changes.
// =============================================================================

const CHANGED_CHANNEL = "game:changed";

@Injectable()
export class GameEventsService implements OnModuleInit {
  private readonly emitter = new EventEmitter();

  constructor(@Optional() private readonly pubsub?: RedisPubSubService) {
    // Many concurrent sockets may subscribe; lift the default 10-listener cap.
    this.emitter.setMaxListeners(0);
  }

  onModuleInit(): void {
    // A mutation committed on another task must still nudge our local spectators.
    this.pubsub?.subscribe(CHANGED_CHANNEL, (payload) => {
      const gameId = (payload as { gameId?: string })?.gameId;
      if (gameId) this.emitLocal(gameId);
    });
  }

  /** Announce that `gameId` changed (called AFTER the mutation transaction commits). */
  emitChanged(gameId: string): void {
    this.emitLocal(gameId); // local subscribers, synchronously
    this.pubsub?.publish(CHANGED_CHANNEL, { gameId }); // other tasks, via Redis
  }

  /** Subscribe to all game changes. Returns an unsubscribe function. */
  onChanged(listener: (gameId: string) => void): () => void {
    this.emitter.on("changed", listener);
    return () => this.emitter.off("changed", listener);
  }

  private emitLocal(gameId: string): void {
    this.emitter.emit("changed", gameId);
  }
}
