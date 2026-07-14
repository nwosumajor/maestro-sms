import {
  CHARS_PER_WORD,
  TYPING_DIFFICULTY_SPECS,
  computeTypingResult,
  rankTypingStandings,
  type TypingStanding,
} from "./typing";

describe("Typing Race engine", () => {
  describe("difficulty profiles", () => {
    it("scale up length + target WPM easy→hard", () => {
      expect(TYPING_DIFFICULTY_SPECS.EASY.maxChars).toBeLessThan(TYPING_DIFFICULTY_SPECS.HARD.minChars);
      expect(TYPING_DIFFICULTY_SPECS.EASY.targetWpm).toBeLessThan(TYPING_DIFFICULTY_SPECS.HARD.targetWpm);
      expect(TYPING_DIFFICULTY_SPECS.HARD.includeNumbers).toBe(true);
      expect(TYPING_DIFFICULTY_SPECS.EASY.includeNumbers).toBe(false);
    });
  });

  describe("computeTypingResult", () => {
    it("perfect full type → finished, 100% accuracy", () => {
      const target = "the quick brown fox"; // 19 chars
      const r = computeTypingResult(target, target, 60000); // 60s = 1 min
      expect(r.finished).toBe(true);
      expect(r.accuracy).toBe(1);
      // gross = 19/5 / 1 = 3.8 wpm
      expect(r.grossWpm).toBeCloseTo(3.8, 2);
      expect(r.netWpm).toBeCloseTo(3.8, 2);
      expect(r.errors).toBe(0);
    });

    it("counts per-position errors and lowers accuracy + net WPM", () => {
      const r = computeTypingResult("hello", "hallo", 60000);
      expect(r.correctChars).toBe(4); // position 1 wrong (a vs e)
      expect(r.errors).toBe(1);
      expect(r.accuracy).toBeCloseTo(0.8, 5);
      expect(r.finished).toBe(false);
      expect(r.netWpm).toBeLessThan(r.grossWpm);
    });

    it("typing beyond the target counts extra chars as errors", () => {
      const r = computeTypingResult("hi", "hiya", 60000);
      expect(r.correctChars).toBe(2);
      expect(r.errors).toBe(2); // 'y','a' beyond target
      expect(r.finished).toBe(false);
    });

    it("empty typed → neutral (accuracy 1, 0 WPM, not finished)", () => {
      const r = computeTypingResult("hello", "", 5000);
      expect(r).toMatchObject({ correctChars: 0, errors: 0, accuracy: 1, grossWpm: 0, netWpm: 0, finished: false });
    });

    it("zero elapsed → 0 WPM (no divide-by-zero)", () => {
      const r = computeTypingResult("hello", "hello", 0);
      expect(r.grossWpm).toBe(0);
      expect(r.netWpm).toBe(0);
      expect(r.finished).toBe(true);
    });

    it("WPM uses the 5-chars-per-word standard", () => {
      const word = "a".repeat(CHARS_PER_WORD * 10); // 50 chars = 10 words
      const r = computeTypingResult(word, word, 60000);
      expect(r.grossWpm).toBeCloseTo(10, 5);
    });
  });

  describe("rankTypingStandings", () => {
    it("finishers first, then net WPM, then accuracy, then time", () => {
      const rows: TypingStanding[] = [
        { playerId: "slow", netWpm: 30, accuracy: 1, finished: true, elapsedMs: 9000 },
        { playerId: "dnf", netWpm: 90, accuracy: 1, finished: false, elapsedMs: 3000 },
        { playerId: "fast", netWpm: 55, accuracy: 0.98, finished: true, elapsedMs: 5000 },
      ];
      expect(rankTypingStandings(rows).map((r) => r.playerId)).toEqual(["fast", "slow", "dnf"]);
    });
  });
});
