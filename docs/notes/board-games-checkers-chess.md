# Checkers + Chess board games

> Checkers + Chess (turn-based 2-player peer duels) FULLY built + live-verified + COMMITTED (branch feat/games-typing-checkers-chess, 6bfe0f8 checkers + c4a6c7c chess): 1 tenant table each (checkers_game/chess_game), RLS 68/69, service/controller, reuse game.play (no new perm), server-validated moves, interactive board web UIs. COMPLETES the 5-game program (games 4+5 of 5).

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Games 4 & 5 of the classroom suite ([classroom-games-engines](classroom-games-engines.md)) — the two
turn-based BOARD games. Unlike the class-hosted parallel games (quiz/hangman/
typing), these are PEER DUELS modelled on the Dead & Wounded duel: a player
creates a game, another in the same school joins, they alternate turns. So they
REUSE `game.play` + `game.leaderboard.read` — NO new permission, no seed change.

**Both BUILT + verified + committed:**
- Checkers: schema `checkers.prisma` (CheckersGame — board JSON + turn; creator=
  black, moves first), migration `20260714040000`, RLS file 68. `CheckersService`/
  `Controller`. Engine `checkers` (namespaced). Committed 6bfe0f8.
- Chess: schema `chess.prisma` (ChessGame — board/castling/ep + halfmove/fullmove
  clocks ALL persisted so the engine rebuilds exactly; creator=white, moves first),
  migration `20260714050000`, RLS file 69. `ChessService`/`Controller`. Engine
  `chess` (namespaced). Committed c4a6c7c.
- Both: every move validated SERVER-SIDE via the engine (applyMove/legalMoves);
  turn order + win/mate/stalemate/draw computed server-side; resignation. Perfect-
  information → board public, server offers the current player's legal moves (chess
  incl. the 4 promotion variants + castle moves). Relationship scoping: only the 2
  participants act; ACTIVE/FINISHED viewable by participants+school-wide staff;
  LOBBY joinable by anyone in school. 404-not-403. Audited. 1 RLS e2e case each.
- Web: `/games/checkers` + `/games/chess` (new game + open/your games) and
  `/[id]` interactive boards (CheckersPlay: click piece→legal dest, multi-jump;
  ChessPlay: unicode board, promotion picker, Check! indicator). Hub cards.
  GOTCHA: `Serialized<>` flattens the `[number,number]` tuple types to `number[]`
  — type the board-move helpers as `number[]`, not the tuple DTO type.
- TIME CONTROLS now ADDED (was deferred): per-player chess clock is the board-game
  "difficulty". Migration `20260714060000_board_game_clocks` adds difficulty +
  whiteTimeMs/blackTimeMs + turnStartedAt to both tables (columns only, no RLS
  change). Base from engine BOARD_TIME_CONTROLS (Classical 15+10 / Rapid 5+5 /
  Blitz 3+2). Create takes difficulty; clock starts on join; each move deducts
  elapsed + adds increment; flag-fall (clock 0 on move) = loss; `claim-time`
  endpoint lets the opponent claim once the current player flags (can't claim
  own; outcome "TIME"). Web: BoardClocks (ticking, red-when-low) + claim button +
  time-control picker on New game. Merged to main ae37d5b + pushed.
- Verified LIVE: checkers 2-player smoke (turn enforcement/illegal move/resign/
  win); chess smoke plays FOOL'S MATE through the API (checkmate→black wins);
  both real-data web E2E; 168 engine tests + FULL RLS e2e (141) green; 80 routes.

**5-GAME PROGRAM COMPLETE.** See [live-quiz-module](live-quiz-module.md) [hangman-module](hangman-module.md)
[typing-race-module](typing-race-module.md). Branch feat/games-typing-checkers-chess (cc9c543 typing ·
6bfe0f8 checkers · c4a6c7c chess) MERGED to main (merge 2157153) and PUSHED to
origin. All 5 games now on main/origin.
