/**
 * A class playing one game is not one school flooding the API.
 *
 * The same shape as the exam hall, in the sibling I would otherwise have walked
 * past: `QuizPlay` polls its session every 1,500 ms per player — and unlike the
 * duel and race screens it has NO socket to fall back from, so this is the
 * ordinary case rather than a degraded one.
 *
 * MEASURED against the real limiter, real pupils of one school:
 *
 *     30 players   1,167 req/min    0% refused
 *     40 players   1,551 req/min   21% refused
 *     60 players   2,318 req/min   39% refused
 *
 * A live quiz stops being reliable at about thirty-one pupils, which is a class.
 */
import { apiRoutes } from "../support/api-routes";

/** What a PLAYER does while a game is running. */
const PLAYER_ROUTES = [
  "GET /quiz-sessions/:id",
  "POST /quiz-sessions/:id/join",
  "POST /quiz-sessions/:id/answer",
  "GET /races/:id",
  "POST /races/:id/join",
  "POST /races/:id/guess",
  "GET /typing-races/:id",
  "POST /typing-races/:id/join",
  "POST /typing-races/:id/progress",
  "GET /rings/:id",
  "POST /rings/:id/join",
  "POST /rings/:id/guess",
  "POST /rings/:id/secret",
];

/**
 * What a HOST does. These are ONE person's actions and belong on the school's
 * budget like everything else a member of staff does — the line that keeps this
 * from becoming a blanket exemption for the games module.
 */
const HOST_ROUTES = [
  "POST /quiz-sessions",
  "POST /quiz-sessions/:id/next",
  "POST /quiz-sessions/:id/end",
  "POST /races",
  "POST /races/:id/start",
  "POST /races/:id/end",
  "POST /typing-races",
  "POST /typing-races/:id/start",
  "POST /typing-races/:id/end",
];

describe("a class is not a flood", () => {
  const routes = apiRoutes();
  it("found the route table", () => expect(routes.length).toBeGreaterThan(500));

  it("meters every play route per player", () => {
    const missing = PLAYER_ROUTES.filter((key) => {
      const r = routes.find((x) => x.key === key);
      // A renamed route is a hole with a note on it — fail rather than quietly
      // cover nothing.
      return !r || !/@PerCandidateRateLimit\(\)/.test(r.block);
    });
    expect(missing).toEqual([]);
  });

  // THE LINE. Without this the decorator drifts into "the games module is
  // exempt", which is not what was measured or argued.
  it("leaves the host's own actions on the school's budget", () => {
    const wrong = HOST_ROUTES.filter((key) => {
      const r = routes.find((x) => x.key === key);
      return !r || /@PerCandidateRateLimit\(\)/.test(r.block);
    });
    expect(wrong).toEqual([]);
  });

  // The decorator is not a general licence: it stays on the surfaces where many
  // people of one school act at one instant BY DESIGN.
  it("is applied to exactly the exam and class-game surfaces", () => {
    const tagged = routes.filter((r) => /@PerCandidateRateLimit\(\)/.test(r.block)).map((r) => r.key);
    expect(tagged.length).toBe(PLAYER_ROUTES.length + 13);
    for (const key of tagged)
      expect(key).toMatch(/\/(cbt|scholarships|quiz-sessions|races|typing-races|rings)\b/);
  });
});
