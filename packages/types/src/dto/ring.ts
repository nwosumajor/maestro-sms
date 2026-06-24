// Dead & Wounded Elimination Ring response DTOs (platform spec §4, step 6).
// Server-form (Date fields are Date); the web consumes Serialized<…>.
//
// SECURITY (spec §9 + §4): NO secret ever appears here (server-only, like the
// duel). A player sees ONLY their own guess history PLUS the "inherited history"
// of players THEY personally eliminated (the §4 reward, session-scoped) — never
// another live player's guesses, and never anyone's secret.

export type RingStatusDto = "LOBBY" | "SETUP" | "ACTIVE" | "FINISHED" | "ABANDONED";

/** A recorded guess in the ring (value + score; never a secret). */
export interface RingGuessDto {
  guesserId: string;
  targetId: string;
  value: string;
  dead: number;
  wounded: number;
  createdAt: Date;
}

/** A ring member, by display name. `ready` only meaningful during SETUP. */
export interface RingPlayerDto {
  playerId: string;
  userId: string;
  displayName: string;
  ready: boolean;
  eliminated: boolean;
  /** Final placing once eliminated / the ring ends (1 = winner), else null. */
  rank: number | null;
  guessCount: number;
}

/** The inherited guess history of one player the viewer eliminated (§4 reward). */
export interface InheritedHistoryDto {
  fromPlayerId: string;
  fromDisplayName: string;
  guesses: RingGuessDto[];
}

/** The viewer-redacted ring view. */
export interface RingDto {
  id: string;
  difficultyLength: number;
  status: RingStatusDto;
  /** GamePlayer.id whose turn it is (null in lobby/setup/finished). */
  currentTurnPlayerId: string | null;
  /** When the current turn started, and when it expires (start + 60s) — the
   *  client renders the countdown / 15s warning. Null outside a live turn. */
  turnStartedAt: Date | null;
  turnExpiresAt: Date | null;
  winnerPlayerId: string | null;
  /** The viewer's own GamePlayer id, if a participant. */
  you: string | null;
  /** Whom the viewer currently targets (their GamePlayer.id), while active. */
  yourTargetPlayerId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  players: RingPlayerDto[];
  /** The viewer's OWN guesses (empty if not a participant). */
  yourGuesses: RingGuessDto[];
  /** Histories inherited from players the viewer eliminated (§4). */
  inheritedHistories: InheritedHistoryDto[];
}
