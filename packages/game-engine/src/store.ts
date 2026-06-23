// =============================================================================
// Game storage seam (platform spec §9 "Persistence")
// =============================================================================
// Step 2 keeps live game state in memory, but BEHIND this interface so the SMS
// integration (step 3) can swap in a Postgres-backed store — with `school_id`
// and RLS per CLAUDE.md — without touching the match logic or the transport.
// =============================================================================

import { Duel } from "./match";

/** Minimal persistence surface a transport needs to manage live games. */
export interface GameStore {
  /** Upsert a game by its id. */
  save(game: Duel): void;
  get(id: string): Duel | undefined;
  delete(id: string): boolean;
  list(): Duel[];
}

/**
 * Process-local, in-memory store. Acceptable for the standalone step-2 server
 * (spec §9). Not durable: a restart loses live games, which is fine pre-SMS.
 */
export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, Duel>();

  save(game: Duel): void {
    this.games.set(game.id, game);
  }

  get(id: string): Duel | undefined {
    return this.games.get(id);
  }

  delete(id: string): boolean {
    return this.games.delete(id);
  }

  list(): Duel[] {
    return [...this.games.values()];
  }
}
