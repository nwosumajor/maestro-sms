// @sms/game-engine — Dead & Wounded game core (platform spec).
// Step 1 (§11.1): the pure scoring engine (`scoring`).
// Step 2 (§11.2): the server-authoritative 2-player match (`match`) + the
// swappable storage seam (`store`). All framework-independent: no I/O lives
// here; the WebSocket transport (apps/game-server) drives these. Every game
// mode depends on this core.
export * from "./scoring";
export * from "./match";
export * from "./store";
// Step 4 (§11.4): pure League/Knockout matchmaking, brackets & standings.
export * from "./competition";
// Step 6 (§11.6 / §4): pure Elimination Ring (re-close, inherited history,
// graduated timeout) — the turn-based core the SMS module and transport drive.
export * from "./ring";
// Step 5 (§11.5 / §5): pure Class Race (shared target, parallel play, top-3 by
// finish order) — the SMS module and transport drive this same core.
export * from "./race";
// Step 8 (§11.8 / §7): pure Ultimate ARENA (rolling solo entry, own per-entry
// target, handle-only, standings-ranked). Governance-free; the SMS service adds
// the cross-school consent/bridge above it.
export * from "./arena";

// ---------------------------------------------------------------------------
// Classroom game suite (new) — pure engines, one shared difficulty scale. Each
// integrates through the SMS with the standard tenant/RLS/relationship pattern.
// ---------------------------------------------------------------------------
export * from "./difficulty"; // shared EASY/MEDIUM/HARD scale + board time controls
export * from "./quiz"; // Kahoot-style live quiz scoring (themed banks)
export * from "./typing"; // typing-race WPM/accuracy scoring
export * from "./hangman"; // hangman state machine
// Chess & checkers share generic names (legalMoves/applyMove/movesEqual/Sq), so
// they are NAMESPACED — consumers use `chess.legalMoves` / `checkers.applyMove`.
export * as chess from "./chess"; // full-rules chess (legal moves, mate/stalemate/draw)
export * as checkers from "./checkers"; // 8x8 draughts rules
