# Live Quiz module

> Live Quiz (Kahoot-style, themed) FULLY built + live-verified end-to-end (backend + web UI): 5 tenant tables (live_quiz*), RLS file 64, service/controller, game.quiz.host perm, engine scoring, answer hidden from students mid-question; web host console + play screen under /games/quiz. First of 5 games DONE. 2026-07-14 UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

First of the 5 new games ([classroom-games-engines](classroom-games-engines.md)) integrated through the
SMS stack, using the RaceService pattern (teacher-opens-for-class, students join,
relationship-scoped, 404-not-403, audited, live-push).

**BACKEND BUILT + live-verified:**
- Schema `packages/db/prisma/schema/live_quiz.prisma`: `LiveQuiz` (title/theme/
  difficulty), `LiveQuizQuestion` (choices JSON + server-only `answerIndex`),
  `LiveQuizSession` (host advances `currentIndex`, server stamps
  `questionStartedAt`), `LiveQuizParticipant` (score/streak/correct),
  `LiveQuizAnswer` (append-only, unique per session+participant+question). Named
  Live* to avoid the LMS `QuizAttempt` collision. Migration
  `20260714000000_live_quiz` (hand-authored SQL, migrate-deployed). RLS file
  `64_live_quiz_rls.sql` (all 5 tables, sentinel `live_quiz_answer_update`),
  registered in docker-entrypoint. School back-relations added.
- `LiveQuizService`/`LiveQuizController` in apps/api/src/game (wired into
  GameModule). Perm `game.quiz.host` added to GAME_PERMISSIONS + GAME_ROLE_PERMISSIONS
  + seeded to teacher/principal/school_admin. DTOs `packages/types/src/dto/live-quiz.ts`.
  Uses `@sms/game-engine` quiz.ts (scoreQuizAnswer / rankQuizStandings /
  QUIZ_DIFFICULTY_SPECS). @RequireModule(GAMES) + @RequirePermission (host=quiz.host,
  play=game.play, read=leaderboard.read).
- SECURITY verified: a question's correct answerIndex is NULL in the player view
  while live (host sees it), revealed only after the question's time limit
  elapses or session ENDs. Server-authoritative timing from questionStartedAt.
- Verified LIVE (real Postgres): migrate deploy OK, RLS applied (5 tables
  relrowsecurity=t), 5 RLS cross-tenant cases PASS + coverage gate green, api
  build+typecheck clean, monorepo typecheck 13/13, and a full functional smoke
  (create→open→join→next→answer scored 799pts→double-answer 409→leaderboard→
  ENDED→unrelated denied). Test data cleaned.

**WEB UI DONE** (`apps/web/app/(app)/games/quiz/*` + `components/game/Quiz*.tsx`):
- `/games/quiz` (index): open/live sessions list (Join/Resume/Host) + host-only
  `QuizHostConsole` (author a quiz w/ dynamic question rows + radio-correct;
  open a session for one of `/classes/mine`). Gated on `game.quiz.host`.
- `/games/quiz/[id]`: `QuizPlay` — host drives (Start → Next question → Finish/
  End); players tap a choice against a per-question countdown (from
  `question.startedAt`+`timeLimitSeconds`); correct-answer highlight only once
  the server reveals it; live leaderboard + own score/streak. Uses `usePolled`
  (1.5s; no `/ws/watch` mode added — REST poll, matching the degrade path).
- Hub card added to `/games`. Reuses `postSms`/`StatusLine`/`usePolled` from
  play-ui; brand2 green for correct. `LiveQuizSelfDto` has NO userId (only
  participantId) — don't try to self-highlight the leaderboard by userId.
Verified: web tsc clean, production build (72 routes incl. 2 new), 3-role route
smoke green, AND a real-data web E2E (teacher cookie → SSR play page shows quiz
title+leaderboard; index lists the session + author console). Test data cleaned.

**Gap-fixes DONE (commit 0cc6063):** edit (PUT /quizzes/:id — update meta +
REPLACE questions, blocked while a session is live; needs the scoped DELETE
policy `rls/66_live_quiz_question_delete.sql` on live_quiz_question) + delete
(DELETE /quizzes/:id → soft-archive via new `archived` col, migration
20260714020000; never hard-delete → game history survives) + seeded 1 starter
quiz per theme (Geography/Science/Art/Literature, idempotent). Web
QuizHostConsole gained Edit/Delete. Leaderboard name lookups batched (d917d1e).

**Branch feat/classroom-games commits:** bf2a917 engines · 2f93c8a quiz backend ·
38c3e4f quiz web · 650fd26 hangman backend · 20e8e54 hangman web · d917d1e perf ·
0cc6063 quiz edit/delete+starters. COMMITTED.
**Optional polish (not done):** `/ws/watch` push mode for quiz/hangman (1.5s poll
today). **Remaining games:** typing, checkers, chess (engines built+tested).
