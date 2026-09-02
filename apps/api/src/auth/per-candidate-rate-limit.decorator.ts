import { SetMetadata } from "@nestjs/common";

export const PER_CANDIDATE_RATE_LIMIT_KEY = "sms:per_candidate_rate_limit";

/**
 * Meter this route per CANDIDATE rather than per school.
 *
 * The tenant limiter exists for one school's RUNAWAY traffic — its own comment
 * says it is there "to cap pathological floods, not to shape traffic" — and it
 * is keyed on `school_id`, so every user in a school draws on one budget. That
 * is right for interactive use and wrong for the one workload in this platform
 * that is legitimately not interactive: an exam hall, where a whole cohort
 * answers questions at the same time because that is what an exam IS.
 *
 * MEASURED, not assumed. A 486-candidate two-paper sitting is ~41,000 requests
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
 * DELIBERATELY NOT AN EXEMPTION. Golden Rule #7 — an unmetered exam surface
 * would be the less restrictive option and there is no need for it: what these
 * routes can do is already bounded by the sitting (a candidate answers only
 * questions on their own paper, each answer is an upsert, and the server's own
 * deadline closes it).
 */
export const PerCandidateRateLimit = () => SetMetadata(PER_CANDIDATE_RATE_LIMIT_KEY, true);
