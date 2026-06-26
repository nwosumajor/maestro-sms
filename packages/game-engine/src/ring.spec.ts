import { Ring, RingError, type RingOptions } from "./ring";

const SECRETS: Record<string, string> = { alice: "1234", bob: "5678", carol: "9012", dave: "3456" };

/** Build a ring already ACTIVE with the given players (join order = ring order).
 *  Ring is alice→bob→carol(→dave)→alice; the first player joined moves first. */
function activeRing(players: string[] = ["alice", "bob", "carol"], opts: Partial<RingOptions> = {}): Ring {
  const r = new Ring({ id: "r1", difficultyLength: 4, ...opts });
  for (const id of players) r.join(id, id[0]!.toUpperCase() + id.slice(1));
  r.start();
  for (const id of players) r.submitSecret(id, SECRETS[id]!);
  return r;
}

describe("Ring — Elimination Ring engine (spec §4 / §11.6)", () => {
  describe("construction & lobby", () => {
    it("rejects an unsupported difficulty length", () => {
      expect(() => new Ring({ id: "r", difficultyLength: 3 })).toThrow(RingError);
      expect(() => new Ring({ id: "r", difficultyLength: 7 })).toThrow(RingError);
    });

    it("rejects duplicates and a full ring", () => {
      const r = new Ring({ id: "r", difficultyLength: 4, maxPlayers: 3 });
      r.join("alice", "Alice");
      expect(() => r.join("alice", "again")).toThrow(/ALREADY_JOINED/);
      r.join("bob", "Bob");
      r.join("carol", "Carol");
      expect(() => r.join("dave", "Dave")).toThrow(/FULL/);
    });

    it("needs at least minPlayers to start", () => {
      const r = new Ring({ id: "r", difficultyLength: 4 });
      r.join("alice", "Alice");
      r.join("bob", "Bob");
      expect(() => r.start()).toThrow(/TOO_FEW/);
      r.join("carol", "Carol");
      r.start();
      expect(r.status).toBe("setup");
    });
  });

  describe("setup → activation", () => {
    it("cannot guess before active and forms the ring once all secrets are in", () => {
      const r = new Ring({ id: "r", difficultyLength: 4 });
      r.join("alice", "Alice");
      r.join("bob", "Bob");
      r.join("carol", "Carol");
      r.start();
      expect(() => r.guess("alice", "1234")).toThrow(/NOT_ACTIVE/);
      r.submitSecret("alice", "1234");
      r.submitSecret("bob", "5678");
      expect(r.status).toBe("setup"); // not all in yet
      r.submitSecret("carol", "9012");
      expect(r.status).toBe("active");
      // First joined moves first, targeting the next around the ring.
      expect(r.currentTurnPlayerId).toBe("alice");
      expect(r.viewFor("alice").yourTargetId).toBe("bob");
    });

    it("rejects an invalid secret and a double submission", () => {
      const r = new Ring({ id: "r", difficultyLength: 4 });
      ["alice", "bob", "carol"].forEach((id) => r.join(id, id));
      r.start();
      expect(() => r.submitSecret("alice", "1123")).toThrow(/INVALID_SECRET/);
      r.submitSecret("alice", "1234");
      expect(() => r.submitSecret("alice", "5678")).toThrow(/SECRET_SET/);
    });
  });

  describe("turn order & authority", () => {
    it("enforces whose turn it is and validates the guess", () => {
      const r = activeRing();
      expect(() => r.guess("bob", "5678")).toThrow(/NOT_YOUR_TURN/);
      expect(() => r.guess("alice", "1123")).toThrow(/INVALID_GUESS/);
    });

    it("passes the turn around the ring on a non-winning guess", () => {
      const r = activeRing();
      // alice targets bob (5678); a wrong, valid guess passes the turn to bob.
      r.guess("alice", "9012");
      expect(r.currentTurnPlayerId).toBe("bob");
      r.guess("bob", "1234"); // bob targets carol (9012); wrong → turn to carol
      expect(r.currentTurnPlayerId).toBe("carol");
    });

    it("NEVER serializes a secret field, and never leaks an un-cracked secret", () => {
      const r = activeRing();
      r.guess("alice", "5678"); // alice cracks bob (5678)
      r.guess("carol", "1234"); // carol cracks alice (1234) → carol wins
      expect(r.status).toBe("finished");
      // A cracking guess VALUE legitimately equals the secret it cracked and shows
      // in the cracker's own history — that's expected. But carol's secret (9012)
      // was NEVER guessed, so it must appear in no view; nor any `secret` key.
      for (const viewer of [null, "alice", "bob", "carol"]) {
        const view = r.viewFor(viewer);
        const json = JSON.stringify(view);
        expect(json).not.toContain("9012"); // carol's un-cracked secret
        expect(json).not.toMatch(/"secret"/);
        expect(view.players.every((p) => !("secret" in p))).toBe(true);
      }
    });
  });

  describe("crack → eliminate → re-close → inherited history", () => {
    it("eliminates the target, re-closes the ring, and advances play", () => {
      const r = activeRing();
      // alice cracks bob → bob out, alice inherits bob's target (carol).
      const res = r.guess("alice", "5678");
      expect(res).toEqual({ dead: 4, wounded: 0 });
      expect(r.viewFor("bob").players.find((p) => p.id === "bob")?.eliminated).toBe(true);
      // turn advances to alice's NEW target, carol.
      expect(r.currentTurnPlayerId).toBe("carol");
      expect(r.viewFor("alice").yourTargetId).toBe("carol");
    });

    it("reveals the eliminated player's history ONLY to the player who cracked them", () => {
      const r = activeRing();
      r.guess("alice", "9012"); // alice misses bob → turn to bob
      r.guess("bob", "1234"); // bob misses carol → turn to carol
      r.guess("carol", "1234"); // carol cracks alice → alice out, eliminatedBy carol
      const carolView = r.viewFor("carol");
      const inh = carolView.inheritedHistories;
      expect(inh).toHaveLength(1);
      expect(inh[0]?.fromPlayerId).toBe("alice");
      expect(inh[0]?.guesses.map((g) => g.value)).toEqual(["9012"]);
      // Nobody else sees alice's inherited history.
      expect(r.viewFor("bob").inheritedHistories).toHaveLength(0);
      // A viewer only ever sees their OWN guesses in yourGuesses.
      expect(carolView.yourGuesses.map((g) => g.value)).toEqual(["1234"]);
    });
  });

  describe("graduated timeout (spec §4: skip ×2 → forfeit on 3rd)", () => {
    it("skips the first two missed turns and forfeits a player on the third", () => {
      const r = activeRing(); // alice, bob, carol — turn order alice→bob→carol
      // Seven timeouts: alice misses on turns 1,4,7 → forfeits on her 3rd.
      for (let i = 0; i < 7; i++) r.timeoutTurn();
      const alice = r.viewFor("alice").players.find((p) => p.id === "alice");
      expect(alice?.eliminated).toBe(true);
      expect(r.results.bind(r)).toThrow(); // not finished — bob & carol remain
      const bob = r.viewFor("bob").players.find((p) => p.id === "bob");
      expect(bob?.eliminated).toBe(false);
    });

    it("a guess resets the timeout counter", () => {
      const r = activeRing();
      r.timeoutTurn(); // alice miss 1 → bob
      r.timeoutTurn(); // bob miss 1 → carol
      r.timeoutTurn(); // carol miss 1 → alice
      r.guess("alice", "9012"); // alice shows up (miss reset) → bob
      // Drive timeouts again; alice will not forfeit on her next two misses.
      for (let i = 0; i < 5; i++) r.timeoutTurn();
      // alice only accrued misses 1,2 since the reset → still in the ring.
      expect(r.viewFor("alice").players.find((p) => p.id === "alice")?.eliminated).toBe(false);
    });
  });

  describe("forfeit & finish", () => {
    it("a voluntary forfeit re-closes the ring around the leaver", () => {
      const r = activeRing(); // alice→bob→carol→alice, turn alice
      r.forfeit("alice");
      // alice out; carol (her predecessor) now targets bob; turn advances to bob.
      expect(r.currentTurnPlayerId).toBe("bob");
      r.guess("bob", "1234"); // bob misses carol → carol
      expect(r.currentTurnPlayerId).toBe("carol");
      expect(r.viewFor("carol").yourTargetId).toBe("bob"); // ring is now bob↔carol
    });

    it("declares the last player standing the winner with reverse-order ranks", () => {
      const r = activeRing();
      r.guess("alice", "5678"); // alice cracks bob (bob = 3rd)
      r.guess("carol", "1234"); // carol cracks alice (alice = 2nd) → carol wins
      expect(r.status).toBe("finished");
      expect(r.winnerId).toBe("carol");
      const byId = new Map(r.results().map((x) => [x.playerId, x]));
      expect(byId.get("carol")).toMatchObject({ rank: 1, outcome: "WON" });
      expect(byId.get("alice")).toMatchObject({ rank: 2, outcome: "ELIMINATED" });
      expect(byId.get("bob")).toMatchObject({ rank: 3, outcome: "ELIMINATED" });
    });

    it("wins by forfeit when everyone else leaves", () => {
      const r = activeRing();
      r.forfeit("alice");
      r.forfeit("bob");
      expect(r.status).toBe("finished");
      expect(r.winnerId).toBe("carol");
      const byId = new Map(r.results().map((x) => [x.playerId, x]));
      expect(byId.get("carol")).toMatchObject({ rank: 1, outcome: "WON" });
      expect(byId.get("alice")).toMatchObject({ rank: 3, outcome: "FORFEIT" });
    });

    it("abandon ends the ring with no winner and results stay unavailable", () => {
      const r = activeRing();
      r.abandon();
      expect(r.status).toBe("abandoned");
      expect(r.winnerId).toBeNull();
      expect(r.currentTurnPlayerId).toBeNull();
      expect(() => r.results()).toThrow(/NOT_FINISHED/);
    });
  });
});
