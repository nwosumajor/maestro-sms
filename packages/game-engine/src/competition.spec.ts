// Pure competition logic tests (spec §6) — matchmaking, brackets, standings.
// No I/O; RNG injected for reproducibility.
import {
  computeLeagueStandings,
  computeRaceStandings,
  isValidHandle,
  leagueMatchups,
  pairKnockoutRound,
  roundRobinRounds,
  shuffle,
  type MatchOutcome,
  type Pairing,
  type RaceFinish,
} from "./competition";

const sortPair = (p: Pairing): Pairing => (p[0] < p[1] ? p : [p[1], p[0]]);
const keyOf = (p: Pairing) => sortPair(p).join("-");

describe("shuffle", () => {
  it("is a permutation (no loss/dup) and never mutates the input", () => {
    const input = ["a", "b", "c", "d", "e"];
    const copy = input.slice();
    const out = shuffle(input, mulberry32(1));
    expect(out.slice().sort()).toEqual(input.slice().sort());
    expect(input).toEqual(copy); // original untouched
  });

  it("is deterministic for a fixed seed", () => {
    expect(shuffle([1, 2, 3, 4], mulberry32(42))).toEqual(shuffle([1, 2, 3, 4], mulberry32(42)));
  });
});

describe("roundRobinRounds", () => {
  it("pairs every player with every other exactly once (even count)", () => {
    const players = ["a", "b", "c", "d"];
    const rounds = roundRobinRounds(players);
    const matches = rounds.flat();
    // C(4,2) = 6 unique matchups, no repeats.
    expect(matches.length).toBe(6);
    expect(new Set(matches.map(keyOf)).size).toBe(6);
  });

  it("gives each player at most one match per round (no double-booking)", () => {
    const players = ["a", "b", "c", "d", "e", "f"];
    for (const round of roundRobinRounds(players)) {
      const seen = round.flat();
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it("handles an odd count: one bye per round, still every pair once", () => {
    const players = ["a", "b", "c", "d", "e"]; // 5 → C(5,2)=10 matchups, bye each round
    const rounds = roundRobinRounds(players);
    const matches = rounds.flat();
    expect(matches.length).toBe(10);
    expect(new Set(matches.map(keyOf)).size).toBe(10);
    // 5 rounds, each missing exactly one player (the bye).
    expect(rounds.length).toBe(5);
    for (const round of rounds) expect(round.length).toBe(2);
  });

  it("never pairs a player with themselves", () => {
    for (const [a, b] of leagueMatchups(["a", "b", "c", "d", "e"])) expect(a).not.toBe(b);
  });

  it("returns no matches for <2 players", () => {
    expect(roundRobinRounds(["solo"])).toEqual([]);
    expect(roundRobinRounds([])).toEqual([]);
  });
});

describe("pairKnockoutRound", () => {
  it("pairs an even field sequentially with no bye", () => {
    const { pairs, bye } = pairKnockoutRound(["s1", "s2", "s3", "s4"]);
    expect(bye).toBeNull();
    expect(pairs).toEqual([
      ["s1", "s2"],
      ["s3", "s4"],
    ]);
  });

  it("gives the bye to the highest seed on an odd field", () => {
    const { pairs, bye } = pairKnockoutRound(["top", "b", "c", "d", "e"]);
    expect(bye).toBe("top");
    expect(pairs).toEqual([
      ["b", "c"],
      ["d", "e"],
    ]);
  });

  it("never gives the same player two byes", () => {
    const { bye } = pairKnockoutRound(["top", "b", "c"], ["top"]);
    expect(bye).toBe("b"); // top already byed → next highest seed
  });

  it("falls back to the top seed if everyone has already byed", () => {
    const { bye } = pairKnockoutRound(["x", "y", "z"], ["x", "y", "z"]);
    expect(bye).toBe("x");
  });

  it("declares a champion when one player remains", () => {
    expect(pairKnockoutRound(["champ"])).toEqual({ pairs: [], bye: "champ" });
    expect(pairKnockoutRound([])).toEqual({ pairs: [], bye: null });
  });
});

describe("computeLeagueStandings", () => {
  const matches: MatchOutcome[] = [
    { aId: "a", bId: "b", winnerId: "a", aGuesses: 5, bGuesses: 8 },
    { aId: "a", bId: "c", winnerId: "a", aGuesses: 6, bGuesses: 9 },
    { aId: "b", bId: "c", winnerId: "b", aGuesses: 7, bGuesses: 7 },
  ];

  it("awards 3 per win, 0 per loss, and ranks by points", () => {
    const s = computeLeagueStandings(["a", "b", "c"], matches);
    const byId = Object.fromEntries(s.map((r) => [r.userId, r]));
    expect(byId.a).toMatchObject({ points: 6, wins: 2, losses: 0, rank: 1 });
    expect(byId.b).toMatchObject({ points: 3, wins: 1, losses: 1, rank: 2 });
    expect(byId.c).toMatchObject({ points: 0, wins: 0, losses: 2, rank: 3 });
  });

  it("sums total guesses across all of a player's matches", () => {
    const s = computeLeagueStandings(["a", "b", "c"], matches);
    const byId = Object.fromEntries(s.map((r) => [r.userId, r]));
    expect(byId.a.totalGuesses).toBe(11); // 5 + 6
    expect(byId.b.totalGuesses).toBe(15); // 8 + 7
    expect(byId.c.totalGuesses).toBe(16); // 9 + 7
  });

  it("breaks equal points by fewest total guesses", () => {
    // x and y each win once (3 pts); x used fewer guesses → ranks higher.
    const tie: MatchOutcome[] = [
      { aId: "x", bId: "z", winnerId: "x", aGuesses: 3, bGuesses: 9 },
      { aId: "y", bId: "z", winnerId: "y", aGuesses: 8, bGuesses: 9 },
    ];
    const s = computeLeagueStandings(["x", "y", "z"], tie);
    expect(s[0]!.userId).toBe("x");
    expect(s[1]!.userId).toBe("y");
    expect(s[0]!.rank).toBe(1);
    expect(s[1]!.rank).toBe(2);
  });

  it("breaks an exact tie by head-to-head result", () => {
    // p and q: same points, same total guesses; p beat q directly → p higher.
    const tie: MatchOutcome[] = [{ aId: "p", bId: "q", winnerId: "p", aGuesses: 4, bGuesses: 4 }];
    const s = computeLeagueStandings(["p", "q"], tie);
    expect(s[0]!.userId).toBe("p");
    expect(s[1]!.userId).toBe("q");
    expect(s[0]!.rank).toBe(1);
  });

  it("lists not-yet-played participants with zeros", () => {
    const s = computeLeagueStandings(["a", "b", "newbie"], []);
    const newbie = s.find((r) => r.userId === "newbie")!;
    expect(newbie).toMatchObject({ points: 0, wins: 0, losses: 0, totalGuesses: 0 });
    // All tied at zero → all share rank 1 (no head-to-head to separate).
    expect(s.every((r) => r.rank === 1)).toBe(true);
  });
});

describe("computeRaceStandings", () => {
  it("ranks by fewest guesses first", () => {
    const finishes: RaceFinish[] = [
      { userId: "slow", guessCount: 9, elapsedMs: 1000 },
      { userId: "fast", guessCount: 4, elapsedMs: 9000 },
      { userId: "mid", guessCount: 6, elapsedMs: 500 },
    ];
    const r = computeRaceStandings(finishes);
    expect(r.map((x) => x.userId)).toEqual(["fast", "mid", "slow"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it("breaks equal guess counts by fastest own-start elapsed time", () => {
    const finishes: RaceFinish[] = [
      { userId: "a", guessCount: 5, elapsedMs: 8000 },
      { userId: "b", guessCount: 5, elapsedMs: 3000 }, // same guesses, quicker
    ];
    const r = computeRaceStandings(finishes);
    expect(r[0]!.userId).toBe("b");
    expect(r[1]!.userId).toBe("a");
  });

  it("does NOT rank by raw elapsed when guess counts differ (guesses dominate)", () => {
    // The student who took longer in time but fewer guesses still wins.
    const r = computeRaceStandings([
      { userId: "fewerGuesses", guessCount: 3, elapsedMs: 60000 },
      { userId: "quicker", guessCount: 7, elapsedMs: 1000 },
    ]);
    expect(r[0]!.userId).toBe("fewerGuesses");
  });

  it("shares a rank on an exact (guesses, elapsed) tie", () => {
    const r = computeRaceStandings([
      { userId: "x", guessCount: 4, elapsedMs: 2000 },
      { userId: "y", guessCount: 4, elapsedMs: 2000 },
    ]);
    expect(r[0]!.rank).toBe(1);
    expect(r[1]!.rank).toBe(1);
  });

  it("returns empty for no finishers", () => {
    expect(computeRaceStandings([])).toEqual([]);
  });
});

describe("isValidHandle", () => {
  it("accepts well-formed handles", () => {
    for (const h of ["Ace", "player_1", "Cool-Cat", "abc", "A1 B2 C3", "x".repeat(24)]) {
      expect(isValidHandle(h)).toBe(true);
    }
  });

  it("rejects too short / too long", () => {
    expect(isValidHandle("ab")).toBe(false);
    expect(isValidHandle("x".repeat(25))).toBe(false);
  });

  it("rejects leading/trailing whitespace and empty", () => {
    expect(isValidHandle(" ace")).toBe(false);
    expect(isValidHandle("ace ")).toBe(false);
    expect(isValidHandle("   ")).toBe(false);
    expect(isValidHandle("")).toBe(false);
  });

  it("rejects disallowed characters (no PII-ish punctuation/symbols)", () => {
    for (const h of ["a@b.com", "first.last", "name!", "emoji😀x", "semi;colon"]) {
      expect(isValidHandle(h)).toBe(false);
    }
  });
});

// Small deterministic PRNG (mulberry32) for reproducible shuffles in tests.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
