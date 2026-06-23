import {
  DIFFICULTY_LENGTHS,
  type DifficultyLength,
  generateSecret,
  isDifficultyLength,
  isWin,
  score,
  validate,
} from "./scoring";

describe("Dead & Wounded scoring engine (spec §2)", () => {
  // ---------------------------------------------------------------------------
  // Canonical + worked cases across all three difficulty lengths
  // ---------------------------------------------------------------------------
  describe("score — canonical and worked cases", () => {
    it("canonical N=4: secret 1920, guess 0127 → dead 1, wounded 2", () => {
      // position 2 matches (2); 0 and 1 are present but misplaced.
      expect(score("0127", "1920")).toEqual({ dead: 1, wounded: 2 });
    });

    it("worked N=5: secret 12345, guess 14325 → dead 3, wounded 2", () => {
      // positions 0,2,4 match (1,3,5); 4 and 2 are misplaced.
      expect(score("14325", "12345")).toEqual({ dead: 3, wounded: 2 });
    });

    it("worked N=6: secret 123456, guess 123465 → dead 4, wounded 2", () => {
      // positions 0-3 match; trailing 6 and 5 are swapped → wounded.
      expect(score("123465", "123456")).toEqual({ dead: 4, wounded: 2 });
    });
  });

  // ---------------------------------------------------------------------------
  // Full win — dead === length, wounded === 0, isWin true (each length)
  // ---------------------------------------------------------------------------
  describe("full win (dead === length)", () => {
    const wins: Array<[DifficultyLength, string]> = [
      [4, "1920"],
      [5, "12345"],
      [6, "123456"],
    ];
    it.each(wins)("N=%i: guessing the secret %s scores all dead", (length, secret) => {
      const result = score(secret, secret);
      expect(result).toEqual({ dead: length, wounded: 0 });
      expect(isWin(result, length)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // All-wounded / zero-dead
  // ---------------------------------------------------------------------------
  describe("all wounded, zero dead", () => {
    it("N=4: secret 1234, guess 2143 → dead 0, wounded 4", () => {
      expect(score("2143", "1234")).toEqual({ dead: 0, wounded: 4 });
    });
    it("N=6: secret 123456, guess 654321 → dead 0, wounded 6", () => {
      expect(score("654321", "123456")).toEqual({ dead: 0, wounded: 6 });
    });
    it("is never a win", () => {
      expect(isWin(score("2143", "1234"), 4)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // No matches at all
  // ---------------------------------------------------------------------------
  describe("no matches (disjoint digit sets)", () => {
    it("N=4: secret 1234, guess 5678 → dead 0, wounded 0", () => {
      expect(score("5678", "1234")).toEqual({ dead: 0, wounded: 0 });
    });
    it("N=5: secret 01234, guess 56789 → dead 0, wounded 0", () => {
      expect(score("56789", "01234")).toEqual({ dead: 0, wounded: 0 });
    });
    // N=6 has no fully-disjoint case: two 6-subsets of {0..9} must share >= 2
    // digits (pigeonhole), so dead+wounded >= 2 always. Asserted as an invariant.
    it("N=6: any two valid secrets overlap in at least 2 digits", () => {
      expect(score("123456", "456789").dead + score("123456", "456789").wounded).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // validate — rejection of invalid inputs
  // ---------------------------------------------------------------------------
  describe("validate", () => {
    it("accepts exactly-length distinct digit strings for 4/5/6", () => {
      expect(validate("1920", 4)).toBe(true);
      expect(validate("13579", 5)).toBe(true);
      expect(validate("123456", 6)).toBe(true);
      expect(validate("0123456789".slice(0, 6), 6)).toBe(true);
    });

    it("rejects repeated digits", () => {
      expect(validate("1123", 4)).toBe(false);
      expect(validate("1233", 4)).toBe(false);
      expect(validate("99999", 5)).toBe(false);
      expect(validate("122456", 6)).toBe(false);
    });

    it("rejects wrong length (too short or too long)", () => {
      expect(validate("123", 4)).toBe(false);
      expect(validate("12345", 4)).toBe(false);
      expect(validate("", 4)).toBe(false);
      expect(validate("1234", 5)).toBe(false);
    });

    it("rejects non-digit characters", () => {
      expect(validate("12a4", 4)).toBe(false);
      expect(validate("12 4", 4)).toBe(false);
      expect(validate("12.4", 4)).toBe(false);
      expect(validate("-123", 4)).toBe(false);
      expect(validate("１２３４", 4)).toBe(false); // full-width digits are not 0-9
    });

    it("rejects unsupported difficulty lengths (not 4/5/6)", () => {
      expect(validate("123", 3)).toBe(false);
      expect(validate("1234567", 7)).toBe(false);
      expect(validate("12", 2)).toBe(false);
      expect(validate("1234", 0)).toBe(false);
      expect(validate("1234", 4.5)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // score — defensive validation (server authority, §9)
  // ---------------------------------------------------------------------------
  describe("score rejects malformed input", () => {
    it("throws on repeated digits in either argument", () => {
      expect(() => score("1123", "1234")).toThrow();
      expect(() => score("1234", "1123")).toThrow();
    });
    it("throws on unequal lengths", () => {
      expect(() => score("123", "1234")).toThrow();
      expect(() => score("12345", "1234")).toThrow();
    });
    it("throws on non-digit characters", () => {
      expect(() => score("12a4", "1234")).toThrow();
    });
    it("throws on unsupported length", () => {
      expect(() => score("123", "456")).toThrow(); // length 3
    });
  });

  // ---------------------------------------------------------------------------
  // isWin
  // ---------------------------------------------------------------------------
  describe("isWin", () => {
    it("is true only when dead === length and wounded === 0", () => {
      expect(isWin({ dead: 4, wounded: 0 }, 4)).toBe(true);
      expect(isWin({ dead: 3, wounded: 1 }, 4)).toBe(false);
      expect(isWin({ dead: 4, wounded: 0 }, 5)).toBe(false); // length mismatch
      expect(isWin({ dead: 6, wounded: 0 }, 6)).toBe(true);
      expect(isWin({ dead: 0, wounded: 0 }, 4)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // generateSecret
  // ---------------------------------------------------------------------------
  describe("generateSecret", () => {
    it.each(DIFFICULTY_LENGTHS)("produces a valid secret of length %i", (length) => {
      for (let i = 0; i < 200; i++) {
        const secret = generateSecret(length);
        expect(validate(secret, length)).toBe(true);
        expect(new Set(secret).size).toBe(length); // distinct
      }
    });

    it("is deterministic given a deterministic RNG", () => {
      const seeded = () => 0; // always picks index 0 in Fisher–Yates
      expect(generateSecret(4, seeded)).toBe(generateSecret(4, seeded));
    });

    it("throws for unsupported lengths", () => {
      expect(() => generateSecret(3)).toThrow();
      expect(() => generateSecret(7)).toThrow();
      expect(() => generateSecret(10)).toThrow();
    });
  });

  describe("isDifficultyLength", () => {
    it("accepts 4/5/6 and rejects everything else", () => {
      expect(isDifficultyLength(4)).toBe(true);
      expect(isDifficultyLength(5)).toBe(true);
      expect(isDifficultyLength(6)).toBe(true);
      for (const n of [0, 1, 2, 3, 7, 8, 9, 10, -4, 4.5]) {
        expect(isDifficultyLength(n)).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Property / exhaustive invariants over many random pairs
  // ---------------------------------------------------------------------------
  describe("invariants over random pairs (property check)", () => {
    it.each(DIFFICULTY_LENGTHS)(
      "N=%i: dead+wounded ≤ N; counts in range; win ⇔ guess === secret; symmetric",
      (length) => {
        for (let i = 0; i < 5000; i++) {
          const secret = generateSecret(length);
          const guess = generateSecret(length);
          const { dead, wounded } = score(guess, secret);

          // counts are in range and never over-count
          expect(dead).toBeGreaterThanOrEqual(0);
          expect(wounded).toBeGreaterThanOrEqual(0);
          expect(dead).toBeLessThanOrEqual(length);
          expect(dead + wounded).toBeLessThanOrEqual(length);

          // a full-dead score happens exactly when guess equals secret
          expect(dead === length).toBe(guess === secret);
          expect(isWin({ dead, wounded }, length)).toBe(guess === secret);

          // dead + wounded == size of the shared digit set (distinct-digit law)
          const shared = new Set([...secret].filter((d) => guess.includes(d))).size;
          expect(dead + wounded).toBe(shared);

          // scoring is symmetric in guess/secret
          expect(score(secret, guess)).toEqual({ dead, wounded });
        }
      },
    );

    it("N=4: exhaustive over a fixed secret against all distinct-digit guesses holds invariants", () => {
      const secret = "1920";
      let sawWin = 0;
      // enumerate all 4-digit distinct-digit strings as guesses
      const digits = "0123456789";
      for (const a of digits)
        for (const b of digits)
          for (const c of digits)
            for (const d of digits) {
              const guess = a + b + c + d;
              if (!validate(guess, 4)) continue; // skip repeated-digit combos
              const { dead, wounded } = score(guess, secret);
              expect(dead + wounded).toBeLessThanOrEqual(4);
              if (dead === 4) sawWin++;
            }
      expect(sawWin).toBe(1); // exactly one guess (the secret) is a full win
    });
  });
});
