import { SetMetadata } from "@nestjs/common";

export const PER_CANDIDATE_RATE_LIMIT_KEY = "sms:per_candidate_rate_limit";

/**
 * Meter this route per PERSON rather than per school.
 *
 * The tenant limiter exists for one school's RUNAWAY traffic — its own comment
 * says it is there "to cap pathological floods, not to shape traffic" — and it
 * is keyed on `school_id`, so every user in a school draws on one budget. That
 * is right for interactive use and wrong for the one workload in this platform
 * that is legitimately not interactive: a room full of pupils answering the
 * same question at the same moment, because that is what an exam — and a
 * classroom game — IS.
 *
 * MEASURED, not assumed, twice. A LIVE QUIZ polls its session every 1,500 ms
 * per player with no socket to fall back from, so a class alone is over the
 * budget and the refusals are silent — the screen simply stops updating:
 *
 *     30 players   1,167 req/min    0% refused
 *     40 players   1,551 req/min   21% refused
 *     60 players   2,318 req/min   39% refused
 *
 * A quiz stops being reliable at about thirty-one pupils, which is a class.
 *
 * And an exam: a 486-candidate two-paper sitting is ~41,000 requests
 * — 34 minutes of that school's ENTIRE per-minute budget inside a 90-minute
 * window, with nothing left for the register, the office or fees. Driven at
 * volume, one school's exam took 7,207 refusals and finished 517 of 972 papers
 * before the window closed. The limiter did not slow the exam down; it ate it.
 *
 * SO THE KEY MOVES, NOT THE CEILING. Each candidate keeps a full budget, which
 * is far more than a person can use — one answer per question on their own open
 * sitting — and candidates stop contending with each other for a number that
 * has nothing to do with them. The abuse the limiter exists for is still
 * caught: a token belongs to ONE user, so a scripted loop is still one key
 * hitting its own ceiling.
 *
 * DELIBERATELY NOT AN EXEMPTION. Golden Rule #7 — an unmetered play surface
 * would be the less restrictive option and there is no need for it: what these
 * routes can do is already bounded by the game (a player acts only on a session
 * they have joined, on the question the SERVER has opened, and the server's own
 * clock closes it).
 *
 * HOST ROUTES ARE NOT TAGGED, and that is the line: opening a quiz, advancing
 * the question, ending a race are ONE person's actions and belong on the
 * school's budget like everything else a member of staff does.
 */
export const PerCandidateRateLimit = () => SetMetadata(PER_CANDIDATE_RATE_LIMIT_KEY, true);
