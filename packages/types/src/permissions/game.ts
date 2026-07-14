// =============================================================================
// Dead & Wounded game — permission constants (platform spec §8)
// =============================================================================
// Fine-grained, `school_id`-scoped strings (except the two ultimate.* + admin
// ones, which are platform/super-admin). Coarse permissions gate ENDPOINTS;
// relationship scoping (a player only acts in games they're entered in; a
// teacher only their classes) narrows ROWS in GameService, backstopped by RLS.
//
// Step 3 (2-player duel) only WIRES `game.play` and `game.leaderboard.read`; the
// rest are defined now because the spec finalizes them, ready for later modes.
// =============================================================================

export const GAME_PERMISSIONS = {
  /** Join and play games one is entered in. */
  PLAY: "game.play",
  /** Open a Class Race for a class (teacher: own classes). */
  RACE_OPEN: "game.race.open",
  /** Schedule a cross-class race tournament (principal/school_admin). */
  RACE_TOURNAMENT: "game.race.tournament",
  /** Create a school League or Knockout. */
  LEAGUE_CREATE: "game.league.create",
  /** Moderate/end a game, remove a player (teacher: own games). */
  MATCH_MODERATE: "game.match.moderate",
  /** View leaderboards/standings (own school). */
  LEADERBOARD_READ: "game.leaderboard.read",
  /** Author + host a live quiz (teacher: own classes; principal/school_admin). */
  QUIZ_HOST: "game.quiz.host",
  /** Host a hangman round (teacher: own classes; principal/school_admin). */
  HANGMAN_HOST: "game.hangman.host",
  /** Manage school-wide game settings/config (school_admin). */
  SETTINGS_MANAGE: "game.settings.manage",
  /** Enroll the school into an Ultimate (cross-school) competition. */
  ULTIMATE_ENROLL: "game.ultimate.enroll",
  /** Manage per-student cross-school consent flags. */
  ULTIMATE_CONSENT: "game.ultimate.consent",
  /** Create/schedule/configure the Ultimate competition (super-admin). */
  ULTIMATE_ADMIN: "game.ultimate.admin",
} as const;

export type GamePermission = (typeof GAME_PERMISSIONS)[keyof typeof GAME_PERMISSIONS];

/** Suggested role → permission additions (spec §8 matrix; spread into the seed). */
export const GAME_ROLE_PERMISSIONS = {
  student: [GAME_PERMISSIONS.PLAY, GAME_PERMISSIONS.LEADERBOARD_READ],
  teacher: [
    GAME_PERMISSIONS.PLAY,
    GAME_PERMISSIONS.RACE_OPEN,
    GAME_PERMISSIONS.MATCH_MODERATE,
    GAME_PERMISSIONS.LEADERBOARD_READ,
    GAME_PERMISSIONS.QUIZ_HOST,
    GAME_PERMISSIONS.HANGMAN_HOST,
  ],
  principal: [
    GAME_PERMISSIONS.RACE_OPEN,
    GAME_PERMISSIONS.RACE_TOURNAMENT,
    GAME_PERMISSIONS.LEAGUE_CREATE,
    GAME_PERMISSIONS.MATCH_MODERATE,
    GAME_PERMISSIONS.LEADERBOARD_READ,
    GAME_PERMISSIONS.QUIZ_HOST,
    GAME_PERMISSIONS.HANGMAN_HOST,
    GAME_PERMISSIONS.ULTIMATE_ENROLL,
  ],
  school_admin: [
    GAME_PERMISSIONS.RACE_OPEN,
    GAME_PERMISSIONS.RACE_TOURNAMENT,
    GAME_PERMISSIONS.LEAGUE_CREATE,
    GAME_PERMISSIONS.MATCH_MODERATE,
    GAME_PERMISSIONS.LEADERBOARD_READ,
    GAME_PERMISSIONS.QUIZ_HOST,
    GAME_PERMISSIONS.HANGMAN_HOST,
    GAME_PERMISSIONS.SETTINGS_MANAGE,
    GAME_PERMISSIONS.ULTIMATE_ENROLL,
    GAME_PERMISSIONS.ULTIMATE_CONSENT,
  ],
} as const;
