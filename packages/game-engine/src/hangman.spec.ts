import {
  HANGMAN_DIFFICULTY_SPECS,
  guessLetter,
  isValidHangmanWord,
  livesRemaining,
  maskedWord,
  newHangmanState,
} from "./hangman";

describe("Hangman engine", () => {
  describe("difficulty", () => {
    it("fewer lives + longer words as it gets harder", () => {
      expect(HANGMAN_DIFFICULTY_SPECS.EASY.lives).toBeGreaterThan(HANGMAN_DIFFICULTY_SPECS.HARD.lives);
      expect(HANGMAN_DIFFICULTY_SPECS.EASY.maxWordLength).toBeLessThan(HANGMAN_DIFFICULTY_SPECS.HARD.maxWordLength);
    });
  });

  describe("validation & setup", () => {
    it("accepts letters only", () => {
      expect(isValidHangmanWord("Volcano")).toBe(true);
      expect(isValidHangmanWord("co2")).toBe(false);
      expect(isValidHangmanWord("two words")).toBe(false);
      expect(isValidHangmanWord("")).toBe(false);
    });
    it("newHangmanState upper-cases and sets lives from difficulty", () => {
      const s = newHangmanState("Volcano", "MEDIUM");
      expect(s.word).toBe("VOLCANO");
      expect(s.lives).toBe(HANGMAN_DIFFICULTY_SPECS.MEDIUM.lives);
      expect(s.status).toBe("PLAYING");
      expect(maskedWord(s)).toBe("_______");
    });
    it("throws on a non-letter word", () => {
      expect(() => newHangmanState("h2o", "EASY")).toThrow();
    });
  });

  describe("guessing", () => {
    it("a hit reveals letters, costs no life", () => {
      const s0 = newHangmanState("APPLE", "EASY");
      const { state, hit, duplicate } = guessLetter(s0, "p");
      expect(hit).toBe(true);
      expect(duplicate).toBe(false);
      expect(maskedWord(state)).toBe("_PP__");
      expect(livesRemaining(state)).toBe(HANGMAN_DIFFICULTY_SPECS.EASY.lives);
    });

    it("a miss costs a life", () => {
      const s0 = newHangmanState("APPLE", "EASY");
      const { state, hit } = guessLetter(s0, "z");
      expect(hit).toBe(false);
      expect(state.wrong).toBe(1);
      expect(livesRemaining(state)).toBe(HANGMAN_DIFFICULTY_SPECS.EASY.lives - 1);
    });

    it("repeat guess is a no-op duplicate (no extra life lost)", () => {
      let s = newHangmanState("APPLE", "EASY");
      s = guessLetter(s, "z").state;
      const again = guessLetter(s, "z");
      expect(again.duplicate).toBe(true);
      expect(again.state.wrong).toBe(1);
    });

    it("non-letter / multi-char guesses are ignored", () => {
      const s0 = newHangmanState("APPLE", "EASY");
      expect(guessLetter(s0, "1").duplicate).toBe(true);
      expect(guessLetter(s0, "ab").duplicate).toBe(true);
      expect(guessLetter(s0, "1").state.wrong).toBe(0);
    });

    it("guessing every distinct letter WINS", () => {
      let s = newHangmanState("APPLE", "EASY");
      for (const l of ["A", "P", "L", "E"]) s = guessLetter(s, l).state;
      expect(s.status).toBe("WON");
      expect(maskedWord(s)).toBe("APPLE");
    });

    it("running out of lives LOSES and reveals the word", () => {
      let s = newHangmanState("APPLE", "HARD"); // 5 lives
      for (const l of ["Z", "X", "Q", "W", "Y"]) s = guessLetter(s, l).state;
      expect(s.status).toBe("LOST");
      expect(livesRemaining(s)).toBe(0);
      expect(maskedWord(s)).toBe("APPLE"); // revealed on loss
    });

    it("no further guesses accepted after game over", () => {
      let s = newHangmanState("AB", "EASY");
      s = guessLetter(s, "A").state;
      s = guessLetter(s, "B").state; // WON
      const after = guessLetter(s, "C");
      expect(after.duplicate).toBe(true);
      expect(after.state.status).toBe("WON");
    });
  });
});
