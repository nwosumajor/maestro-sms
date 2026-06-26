import { Arena, ArenaError } from "./arena";
import { generateSecret } from "./scoring";

// With a constant rng, every per-entry target is the same known secret, so a test
// can crack each participant's own target deterministically.
const TARGET = generateSecret(4, () => 0);
const WRONG = TARGET === "9876" ? "0123" : "9876";

function openArena() {
  return new Arena({ id: "u1", difficultyLength: 4, rng: () => 0, now: 0 });
}

describe("Arena — Ultimate cross-school arena engine (spec §7 / §11.8)", () => {
  describe("construction & entry", () => {
    it("rejects an unsupported difficulty length", () => {
      expect(() => new Arena({ id: "u", difficultyLength: 3 })).toThrow(ArenaError);
    });

    it("validates the handle and rejects duplicate ids and handles", () => {
      const a = openArena();
      expect(() => a.enter("p1", "Ax")).toThrow(/INVALID_HANDLE/); // too short
      a.enter("p1", "Alice");
      expect(() => a.enter("p1", "Alice2")).toThrow(/ALREADY_ENTERED/);
      expect(() => a.enter("p2", "alice")).toThrow(/HANDLE_TAKEN/); // case-insensitive
      a.enter("p2", "Bob");
      expect(a.viewFor("p1").participantCount).toBe(2);
    });
  });

  describe("get-ready then race (own target, own clock)", () => {
    it("forbids guessing before begin, and starts the clock at begin", () => {
      const a = openArena();
      a.enter("p1", "Alice");
      expect(() => a.guess("p1", TARGET)).toThrow(/NOT_STARTED/);
      a.begin("p1", 1000);
      expect(() => a.begin("p1", 1100)).toThrow(/NOT_READY/);
      expect(a.viewFor("p1").yourEntry?.status).toBe("racing");
    });

    it("scores against the participant's OWN target and finishes on a crack", () => {
      const a = openArena();
      a.enter("p1", "Alice");
      a.begin("p1", 1000);
      expect(a.guess("p1", WRONG, 1050)).toMatchObject({ dead: expect.any(Number) });
      expect(a.guess("p1", TARGET, 1100)).toEqual({ dead: 4, wounded: 0 });
      const entry = a.viewFor("p1").yourEntry;
      expect(entry).toMatchObject({ status: "finished", guessCount: 2, elapsedMs: 100 });
      expect(() => a.guess("p1", TARGET, 1200)).toThrow(/ALREADY_FINISHED/);
    });
  });

  describe("standings (spec §5 metric: fewest guesses → fastest own-start elapsed)", () => {
    it("ranks finishers by guess count then elapsed, independent of wall clock", () => {
      const a = openArena();
      // Alice: 1 guess, 100ms (entered/began at 1000).
      a.enter("p1", "Alice");
      a.begin("p1", 1000);
      a.guess("p1", TARGET, 1100);
      // Bob: 1 guess but 200ms — slower than Alice though same guess count.
      a.enter("p2", "Bob");
      a.begin("p2", 5000); // different wall-clock start — must not matter
      a.guess("p2", TARGET, 5200);
      // Carol: 2 guesses — more guesses ⇒ ranks below both regardless of speed.
      a.enter("p3", "Carol");
      a.begin("p3", 9000);
      a.guess("p3", WRONG, 9010);
      a.guess("p3", TARGET, 9020);

      const board = a.standings();
      expect(board.map((r) => [r.handle, r.rank])).toEqual([
        ["Alice", 1],
        ["Bob", 2],
        ["Carol", 3],
      ]);
      expect(board[0]).toMatchObject({ guessCount: 1, elapsedMs: 100 });
      expect(a.results()).toEqual(board.map((r) => ({ ...r })));
    });

    it("shows the viewer their own rank once finished", () => {
      const a = openArena();
      a.enter("p1", "Alice");
      a.begin("p1", 1000);
      expect(a.viewFor("p1").yourEntry?.rank).toBeNull(); // not finished yet
      a.guess("p1", TARGET, 1100);
      expect(a.viewFor("p1").yourEntry?.rank).toBe(1);
    });
  });

  describe("security & lifecycle", () => {
    it("NEVER serializes a secret/target in any view", () => {
      const a = openArena();
      a.enter("p1", "Alice");
      a.begin("p1", 1000);
      a.guess("p1", WRONG, 1050);
      for (const viewer of [null, "p1"]) {
        const json = JSON.stringify(a.viewFor(viewer));
        expect(json).not.toContain(TARGET);
        expect(json).not.toMatch(/"secret"/);
      }
    });

    it("closing the arena blocks further entries and guesses", () => {
      const a = openArena();
      a.enter("p1", "Alice");
      a.begin("p1", 1000);
      a.close();
      expect(a.viewFor("p1").status).toBe("closed");
      expect(() => a.enter("p2", "Bob")).toThrow(/CLOSED/);
      expect(() => a.guess("p1", TARGET, 1100)).toThrow(/CLOSED/);
      expect(() => a.close()).toThrow(/CLOSED/);
    });
  });
});
