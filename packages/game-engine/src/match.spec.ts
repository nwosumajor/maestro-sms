import { Duel, DuelError, type DuelOptions } from "./match";

/** Build a duel that is already active. rng:()=>0 makes Alice (joined first) move first. */
function activeDuel(
  opts: Partial<DuelOptions> & { aliceSecret?: string; bobSecret?: string } = {},
): Duel {
  const { aliceSecret = "1234", bobSecret = "5678", ...duelOpts } = opts;
  const d = new Duel({ id: "g1", difficultyLength: 4, rng: () => 0, ...duelOpts });
  d.join("alice", "Alice");
  d.join("bob", "Bob");
  d.submitSecret("alice", aliceSecret);
  d.submitSecret("bob", bobSecret);
  return d;
}

describe("Duel — server-authoritative 2-player match (spec §11 step 2)", () => {
  describe("construction & lobby", () => {
    it("rejects an unsupported difficulty length", () => {
      expect(() => new Duel({ id: "g", difficultyLength: 3 })).toThrow(DuelError);
      expect(() => new Duel({ id: "g", difficultyLength: 7 })).toThrow(DuelError);
    });

    it("admits exactly two players and transitions lobby → setup", () => {
      const d = new Duel({ id: "g", difficultyLength: 4 });
      expect(d.status).toBe("lobby");
      d.join("alice", "Alice");
      expect(d.status).toBe("lobby");
      d.join("bob", "Bob");
      expect(d.status).toBe("setup");
    });

    it("rejects a duplicate player and a third player", () => {
      const d = new Duel({ id: "g", difficultyLength: 4 });
      d.join("alice", "Alice");
      expect(() => d.join("alice", "Alice again")).toThrow(/ALREADY_JOINED|already/i);
      d.join("bob", "Bob");
      expect(() => d.join("carol", "Carol")).toThrow(/FULL|two players/i);
    });

    it("cannot submit a secret or guess before the right phase", () => {
      const d = new Duel({ id: "g", difficultyLength: 4 });
      d.join("alice", "Alice");
      expect(() => d.submitSecret("alice", "1234")).toThrow(/NOT_SETUP|setup/i);
      expect(() => d.guess("alice", "1234")).toThrow(/NOT_ACTIVE|play/i);
    });
  });

  describe("setup", () => {
    it("validates secrets through the engine and rejects invalid ones", () => {
      const d = new Duel({ id: "g", difficultyLength: 4 });
      d.join("alice", "Alice");
      d.join("bob", "Bob");
      expect(() => d.submitSecret("alice", "1123")).toThrow(/INVALID_SECRET/); // repeat
      expect(() => d.submitSecret("alice", "123")).toThrow(/INVALID_SECRET/); // wrong length
      expect(() => d.submitSecret("alice", "12a4")).toThrow(/INVALID_SECRET/); // non-digit
    });

    it("rejects a second secret from the same player", () => {
      const d = new Duel({ id: "g", difficultyLength: 4 });
      d.join("alice", "Alice");
      d.join("bob", "Bob");
      d.submitSecret("alice", "1234");
      expect(() => d.submitSecret("alice", "4321")).toThrow(/SECRET_SET/);
    });

    it("activates and picks a first mover once both secrets are in", () => {
      const d = activeDuel();
      expect(d.status).toBe("active");
      expect(d.currentTurnPlayerId).toBe("alice"); // rng:()=>0
      const d2 = activeDuel({ rng: () => 0.99 });
      expect(d2.currentTurnPlayerId).toBe("bob");
    });
  });

  describe("turn enforcement (server authority)", () => {
    it("forbids guessing out of turn", () => {
      const d = activeDuel(); // Alice's turn
      expect(() => d.guess("bob", "1234")).toThrow(/NOT_YOUR_TURN/);
    });

    it("validates the guess and rejects malformed values", () => {
      const d = activeDuel();
      expect(() => d.guess("alice", "1123")).toThrow(/INVALID_GUESS/);
      expect(() => d.guess("alice", "12")).toThrow(/INVALID_GUESS/);
    });

    it("scores a guess against the OPPONENT's secret and records it; turn passes", () => {
      const d = activeDuel({ aliceSecret: "1234", bobSecret: "5678" });
      // Alice guesses at Bob's secret 5678.
      const r = d.guess("alice", "5670", 1000); // 5,6,7 present & placed; 0 absent
      expect(r).toEqual({ dead: 3, wounded: 0 });
      expect(d.currentTurnPlayerId).toBe("bob"); // turn passed
      const view = d.viewFor("alice");
      const alice = view.players.find((p) => p.id === "alice");
      expect(alice?.guesses).toEqual([{ value: "5670", dead: 3, wounded: 0, at: 1000 }]);
      expect(alice?.guessCount).toBe(1);
    });
  });

  describe("secret redaction (server authority — secrets never reach a client)", () => {
    it("never serializes any secret while the game is active", () => {
      const d = activeDuel({ aliceSecret: "1234", bobSecret: "5678" });
      d.guess("alice", "9012", 1); // a non-winning guess, no secret digits placed
      for (const viewer of ["alice", "bob", null] as const) {
        const json = JSON.stringify(d.viewFor(viewer));
        expect(json).not.toContain("1234"); // Alice's secret
        expect(json).not.toContain("5678"); // Bob's secret — even Bob doesn't get it back over the wire
      }
      // and structurally: no `secret` field is present while active
      for (const p of d.viewFor("alice").players) expect(p.secret).toBeUndefined();
    });

    it("reveals both secrets only once finished", () => {
      const d = activeDuel({ aliceSecret: "1234", bobSecret: "5678" });
      d.guess("alice", "5678"); // Alice cracks Bob → finished
      const view = d.viewFor("bob");
      expect(view.status).toBe("finished");
      const secrets = view.players.map((p) => p.secret).sort();
      expect(secrets).toEqual(["1234", "5678"]);
    });
  });

  describe("winning", () => {
    it("a full crack finishes the game with the cracker as winner", () => {
      const d = activeDuel({ aliceSecret: "1234", bobSecret: "5678" });
      const r = d.guess("alice", "5678", 2000);
      expect(r).toEqual({ dead: 4, wounded: 0 });
      expect(d.status).toBe("finished");
      expect(d.winnerId).toBe("alice");
      expect(d.currentTurnPlayerId).toBeNull();
      expect(d.finishedAt).toBe(2000);
      expect(d.results()).toEqual([
        { playerId: "alice", outcome: "WON", guessCount: 1, rank: 1 },
        { playerId: "bob", outcome: "LOST", guessCount: 0, rank: 2 },
      ]);
    });

    it("cannot guess after the game is finished", () => {
      const d = activeDuel();
      d.guess("alice", "5678"); // win
      expect(() => d.guess("bob", "1234")).toThrow(/NOT_ACTIVE/);
    });

    it("results() throws before the game is finished", () => {
      const d = activeDuel();
      expect(() => d.results()).toThrow(/NOT_FINISHED/);
    });
  });

  describe("full alternating playthrough", () => {
    it("alternates turns and resolves to the correct winner", () => {
      const d = activeDuel({ aliceSecret: "1234", bobSecret: "5678" });
      expect(d.currentTurnPlayerId).toBe("alice");
      expect(d.guess("alice", "9012")).toEqual({ dead: 0, wounded: 0 });
      expect(d.currentTurnPlayerId).toBe("bob");
      expect(d.guess("bob", "9012")).toEqual({ dead: 0, wounded: 2 }); // 1,2 present in 1234
      expect(d.currentTurnPlayerId).toBe("alice");
      expect(d.guess("alice", "5678")).toEqual({ dead: 4, wounded: 0 }); // Alice cracks
      expect(d.status).toBe("finished");
      expect(d.winnerId).toBe("alice");
    });
  });

  describe("forfeit & disconnect", () => {
    it("forfeiting hands the win to the opponent", () => {
      const d = activeDuel();
      d.forfeit("alice", 500);
      expect(d.status).toBe("finished");
      expect(d.winnerId).toBe("bob");
      expect(d.results().find((r) => r.playerId === "bob")?.outcome).toBe("WON");
    });

    it("tracks connection state without leaking secrets", () => {
      const d = activeDuel();
      d.setConnected("alice", false);
      expect(d.viewFor("bob").players.find((p) => p.id === "alice")?.connected).toBe(false);
    });
  });

  describe("turn timeout (graduated skip → forfeit, spec §9)", () => {
    it("skips below the miss threshold and forfeits on reaching it", () => {
      const d = activeDuel({ maxConsecutiveMisses: 2 }); // Alice first
      d.timeoutTurn(); // Alice miss 1 → skip
      expect(d.status).toBe("active");
      expect(d.currentTurnPlayerId).toBe("bob");
      d.timeoutTurn(); // Bob miss 1 → skip
      expect(d.currentTurnPlayerId).toBe("alice");
      d.timeoutTurn(); // Alice miss 2 → forfeit → Bob wins
      expect(d.status).toBe("finished");
      expect(d.winnerId).toBe("bob");
    });

    it("a successful guess resets the player's consecutive-miss counter", () => {
      const d = activeDuel({ maxConsecutiveMisses: 2, aliceSecret: "1234", bobSecret: "5678" });
      d.timeoutTurn(); // Alice miss 1 → Bob
      d.guess("bob", "9012"); // Bob plays (no win) → Alice
      d.guess("alice", "9013"); // Alice plays → resets Alice's misses → Bob
      d.guess("bob", "9014"); // Bob → Alice
      d.timeoutTurn(); // Alice miss 1 again (was reset) → skip, NOT forfeit
      expect(d.status).toBe("active");
      expect(d.currentTurnPlayerId).toBe("bob");
    });

    it("timing out is illegal when no game is active", () => {
      const d = new Duel({ id: "g", difficultyLength: 4 });
      expect(() => d.timeoutTurn()).toThrow(/NOT_ACTIVE/);
    });
  });
});
