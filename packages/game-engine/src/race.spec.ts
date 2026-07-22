import { Race, RaceError, type RaceOptions } from "./race";

/** A race already ACTIVE with the given players and a fixed target for determinism. */
function activeRace(players: string[] = ["a", "b", "c"], opts: Partial<RaceOptions> = {}): Race {
  const r = new Race({ id: "r1", difficultyLength: 4, target: "1234", now: 1000, ...opts });
  for (const id of players) r.join(id, id.toUpperCase());
  r.start(1000);
  return r;
}

describe("Race — Class Race engine (spec §5 / §11.5)", () => {
  describe("construction", () => {
    it("rejects an unsupported difficulty length and an invalid explicit target", () => {
      expect(() => new Race({ id: "r", difficultyLength: 3 })).toThrow(RaceError);
      expect(() => new Race({ id: "r", difficultyLength: 4, target: "1123" })).toThrow(/INVALID_TARGET/);
    });

    it("generates a valid target when none is supplied", () => {
      const r = new Race({ id: "r", difficultyLength: 5, rng: () => 0 });
      r.join("a", "A");
      r.start();
      // A generated target is a real, crackable 5-distinct-digit secret; we can't
      // read it, but the race is well-formed and playable.
      expect(r.status).toBe("active");
      expect(JSON.stringify(r.viewFor("a"))).not.toMatch(/"target"|"secret"/);
    });
  });

  describe("lobby & start", () => {
    it("rejects duplicates, late joins, and starting empty", () => {
      const r = new Race({ id: "r", difficultyLength: 4, target: "1234" });
      r.join("a", "A");
      expect(() => r.join("a", "again")).toThrow(/ALREADY_JOINED/);
      const empty = new Race({ id: "r2", difficultyLength: 4, target: "1234" });
      expect(() => empty.start()).toThrow(/TOO_FEW/);
      r.start();
      expect(() => r.join("b", "B")).toThrow(/NOT_LOBBY/);
    });

    it("cannot guess before the race is active", () => {
      const r = new Race({ id: "r", difficultyLength: 4, target: "1234" });
      r.join("a", "A");
      expect(() => r.guess("a", "1234")).toThrow(/NOT_ACTIVE/);
    });
  });

  describe("parallel play & redaction", () => {
    it("scores against the shared target and validates the guess", () => {
      const r = activeRace();
      expect(r.guess("a", "1234")).toEqual({ dead: 4, wounded: 0 });
      expect(() => r.guess("b", "1123")).toThrow(/INVALID_GUESS/);
    });

    it("shows a racer ONLY their own guesses, never the target or others' guesses", () => {
      const r = activeRace();
      // FIXED clock: the view serializes timestamps, and a real Date.now() can
      // itself contain the digits "1234" — which would fail the leak assertion
      // below for a reason that has nothing to do with leaking the target.
      r.guess("a", "5678", 1500); // A's wrong guess
      const bView = r.viewFor("b");
      expect(bView.yourGuesses).toHaveLength(0); // B sees none of A's guesses
      // Before anyone cracks it, the target appears in NO view and there is no
      // target/secret field anywhere.
      for (const viewer of [null, "a", "b", "c"]) {
        const json = JSON.stringify(r.viewFor(viewer));
        expect(json).not.toContain("1234");
        expect(json).not.toMatch(/"target"|"secret"/);
      }
    });

    it("rejects guessing after you have already finished", () => {
      const r = activeRace(["a", "b", "c", "d"]);
      r.guess("a", "1234"); // A cracks it
      expect(() => r.guess("a", "5678")).toThrow(/ALREADY_FINISHED/);
    });
  });

  describe("finish order, top-3 & elapsed", () => {
    it("ranks finishers by who cracks first and ends after the third (spec §5)", () => {
      const r = activeRace(["a", "b", "c", "d"]);
      r.guess("a", "1234"); // rank 1
      r.guess("b", "1234"); // rank 2
      expect(r.status).toBe("active");
      r.guess("c", "1234"); // rank 3 → race over
      expect(r.status).toBe("finished");
      expect(r.winnerId).toBe("a");
      // D was still racing; D may not guess once the race is over.
      expect(() => r.guess("d", "1234")).toThrow(/NOT_ACTIVE/);

      const ranks = new Map(r.results().map((x) => [x.playerId, x.rank]));
      expect(ranks.get("a")).toBe(1);
      expect(ranks.get("b")).toBe(2);
      expect(ranks.get("c")).toBe(3);
      expect(r.results()).toHaveLength(3); // D never finished
    });

    it("ends when everyone has cracked it even below the top-3 threshold", () => {
      const r = activeRace(["a", "b"]);
      r.guess("a", "1234");
      r.guess("b", "1234"); // all participants finished → over
      expect(r.status).toBe("finished");
      expect(r.winnerId).toBe("a");
    });

    it("records elapsed ms from the race start (own-start basis)", () => {
      const r = activeRace(["a", "b"], {}); // started at now=1000
      r.guess("a", "1234", 1500); // 500ms after start
      const finish = r.viewFor("a").yourFinish;
      expect(finish).toMatchObject({ rank: 1, guessCount: 1, elapsedMs: 500 });
    });
  });

  describe("host end & results", () => {
    it("ends a race early, keeping current finishers' ranks", () => {
      const r = activeRace(["a", "b", "c", "d"]);
      r.guess("a", "1234"); // only A has finished
      r.end();
      expect(r.status).toBe("finished");
      expect(r.winnerId).toBe("a");
      expect(r.results()).toHaveLength(1);
    });

    it("never serializes the target even after the race is over", () => {
      const r = activeRace(["a", "b"]);
      // FIXED clock throughout — see the note above: a wall-clock timestamp
      // that happens to contain "1234" would trip the substring check below.
      r.guess("a", "1234", 1500);
      r.guess("b", "5678", 1600); // B never cracks
      r.end(1700);
      // B's secret-free view: B never guessed 1234, so it appears nowhere for B.
      const json = JSON.stringify(r.viewFor("b"));
      expect(json).not.toContain("1234");
      expect(json).not.toMatch(/"target"|"secret"/);
    });

    it("guards results() until the race is over", () => {
      const r = activeRace();
      expect(() => r.results()).toThrow(/NOT_FINISHED/);
    });
  });
});
