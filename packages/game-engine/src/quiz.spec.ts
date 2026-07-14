import {
  QUIZ_THEMES,
  QUIZ_DIFFICULTY_SPECS,
  QUIZ_STREAK_BONUS,
  isQuizTheme,
  isValidQuizQuestion,
  scoreQuizAnswer,
  rankQuizStandings,
  type QuizQuestion,
} from "./quiz";

const q = (over: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id: "q1",
  prompt: "Capital of Kenya?",
  choices: ["Nairobi", "Lagos", "Cairo", "Accra"],
  answerIndex: 0,
  theme: "GEOGRAPHY",
  difficulty: "MEDIUM",
  ...over,
});

describe("Live Quiz engine", () => {
  describe("themes", () => {
    it("covers the four curriculum variants + general", () => {
      expect(QUIZ_THEMES).toEqual(["GEOGRAPHY", "SCIENCE", "ART", "LITERATURE", "GENERAL"]);
    });
    it("isQuizTheme narrows valid/invalid", () => {
      expect(isQuizTheme("SCIENCE")).toBe(true);
      expect(isQuizTheme("history")).toBe(false);
    });
  });

  describe("scoreQuizAnswer", () => {
    it("wrong answer → 0 points and streak reset", () => {
      expect(scoreQuizAnswer({ correct: false, elapsedMs: 100, priorStreak: 3, difficulty: "EASY" }))
        .toEqual({ points: 0, newStreak: 0 });
    });

    it("timeout (elapsed >= limit) → 0 points and streak reset", () => {
      const limit = QUIZ_DIFFICULTY_SPECS.HARD.timeLimitSeconds * 1000;
      expect(scoreQuizAnswer({ correct: true, elapsedMs: limit, priorStreak: 2, difficulty: "HARD" }))
        .toEqual({ points: 0, newStreak: 0 });
    });

    it("instant correct answer earns full base points", () => {
      const r = scoreQuizAnswer({ correct: true, elapsedMs: 0, priorStreak: 0, difficulty: "MEDIUM" });
      expect(r.points).toBe(QUIZ_DIFFICULTY_SPECS.MEDIUM.basePoints);
      expect(r.newStreak).toBe(1);
    });

    it("answering at the buzzer earns ~half base (linear decay to 0.5)", () => {
      const limitMs = QUIZ_DIFFICULTY_SPECS.EASY.timeLimitSeconds * 1000;
      const r = scoreQuizAnswer({ correct: true, elapsedMs: limitMs - 1, priorStreak: 0, difficulty: "EASY" });
      expect(r.points).toBeGreaterThanOrEqual(Math.round(QUIZ_DIFFICULTY_SPECS.EASY.basePoints * 0.5));
      expect(r.points).toBeLessThan(QUIZ_DIFFICULTY_SPECS.EASY.basePoints * 0.51);
    });

    it("harder difficulty stakes more base points", () => {
      const easy = scoreQuizAnswer({ correct: true, elapsedMs: 0, priorStreak: 0, difficulty: "EASY" }).points;
      const hard = scoreQuizAnswer({ correct: true, elapsedMs: 0, priorStreak: 0, difficulty: "HARD" }).points;
      expect(hard).toBeGreaterThan(easy);
    });

    it("streak adds a capped bonus", () => {
      const s1 = scoreQuizAnswer({ correct: true, elapsedMs: 0, priorStreak: 1, difficulty: "EASY" });
      const s0 = scoreQuizAnswer({ correct: true, elapsedMs: 0, priorStreak: 0, difficulty: "EASY" });
      expect(s1.points - s0.points).toBe(QUIZ_STREAK_BONUS);
      // capped at 5 steps
      const big = scoreQuizAnswer({ correct: true, elapsedMs: 0, priorStreak: 50, difficulty: "EASY" });
      expect(big.points - s0.points).toBe(5 * QUIZ_STREAK_BONUS);
      expect(big.newStreak).toBe(51);
    });
  });

  describe("isValidQuizQuestion", () => {
    it("accepts a well-formed question", () => expect(isValidQuizQuestion(q())).toBe(true));
    it("rejects answerIndex out of range", () => expect(isValidQuizQuestion(q({ answerIndex: 4 }))).toBe(false));
    it("rejects < 2 choices", () => expect(isValidQuizQuestion(q({ choices: ["only"] }))).toBe(false));
    it("rejects blank prompt", () => expect(isValidQuizQuestion(q({ prompt: "  " }))).toBe(false));
    it("rejects blank choice", () => expect(isValidQuizQuestion(q({ choices: ["A", " "] , answerIndex: 0}))).toBe(false));
  });

  describe("rankQuizStandings", () => {
    it("orders by score, then correct, then id (stable)", () => {
      const ranked = rankQuizStandings([
        { playerId: "b", score: 100, correct: 2, streak: 0 },
        { playerId: "a", score: 300, correct: 4, streak: 1 },
        { playerId: "c", score: 300, correct: 3, streak: 0 },
      ]);
      expect(ranked.map((s) => s.playerId)).toEqual(["a", "c", "b"]);
    });
  });
});
