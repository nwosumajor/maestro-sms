// =============================================================================
// Anything with a finite number of places has to be CLAIMED, not counted
// =============================================================================
// A bed, a seat on a bus, a place in a class, a parent-evening slot, a library
// copy. Every one is the same shape: count what is taken, compare it to a limit,
// then insert. At READ COMMITTED two requests both read the old count and both
// insert, and the room holds one more child than it has beds.
//
// This platform has already been through that once — the guards are in place and
// each carries its own note. What this file does is keep them there, because the
// failure is invisible in testing (it needs two requests in the same
// millisecond) and shows up as a physical fact: a child with no bed.
//
// Two forms count as a claim:
//   FOR UPDATE       hold the contended row for the rest of the transaction
//                    (a room, a route, a class), then count and insert.
//   conditional UPDATE  `updateMany({ where: { …still available… } })` and act
//                    only if count === 1 — the database decides the winner.
//
// A capacity compared against a count with NEITHER above it is the defect.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "../../src", rel), "utf8");

/**
 * Each contended resource, and the file that hands out its places.
 *
 * Named deliberately rather than discovered: a scan wide enough to find every
 * capacity check also finds `if (input.capacity < 1)` on a form, and a list of
 * false positives is one nobody reads. The broad sweep below catches a NEW file
 * that starts handing out places.
 */
const CONTENDED: Array<[string, string]> = [
  ["a hostel bed (allocate)", "hostel/hostel.service.ts"],
  ["a place in a class (promotion)", "lms/promotion.service.ts"],
  ["a seat on a bus", "transport/transport.service.ts"],
  ["a parent-evening slot", "meeting/meeting.service.ts"],
  ["a library copy", "library/library.service.ts"],
];

const CLAIM = /FOR UPDATE|updateMany\(/;

describe("places that can run out", () => {
  it.each(CONTENDED)("%s is claimed, not merely counted", (_what, file) => {
    const src = read(file);
    expect(src).toMatch(CLAIM);
  });

  it("a hostel TRANSFER claims the destination too, not just a fresh allocation", () => {
    // The one most likely to be missed: allocate() was guarded first, and
    // transfer moves a child into a room the same way. Two locks, two paths.
    const src = read("hostel/hostel.service.ts");
    expect(src.match(/FOR UPDATE/g) ?? []).toHaveLength(2);
    expect(src).toMatch(/toRoomId\}::uuid FOR UPDATE/);
  });

  it("the library claims a copy in the UPDATE itself, so two borrowers cannot take one book", () => {
    const src = read("library/library.service.ts");
    expect(src).toMatch(/availableCopies:\s*\{\s*gt(e)?:\s*(0|1)/);
  });

  it("exam seating replaces the plan rather than adding to it", () => {
    // Its capacity check compares only the incoming students, which is correct
    // ONLY because the previous plan is deleted first. If that delete ever goes,
    // the check silently becomes wrong and a hall over-seats.
    const src = read("exam/exam.service.ts");
    const seat = src.slice(src.indexOf("async seat("), src.indexOf("async seat(") + 900);
    expect(seat).toMatch(/deleteMany\(\{ where: \{ sittingId \} \}\)/);
    expect(seat.indexOf("deleteMany")).toBeLessThan(seat.indexOf("createMany"));
  });
});

describe("nowhere new starts handing out places unguarded", () => {
  it("every file that compares a count to a capacity also claims it", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const SRC = join(__dirname, "../../src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    const offenders = walk(SRC)
      .filter((p) => !p.includes(".spec."))
      .filter((p) => {
        const src = readFileSync(p, "utf8");
        // "occupied >= room.capacity" and friends: a count on the left, a
        // capacity on the right. Not a form validating its own input.
        const gates = /\b\w+\s*>=\s*\w+\.capacity\b/.test(src);
        return gates && !CLAIM.test(src);
      })
      .map((p) => p.slice(SRC.length + 1));
    // A walk that finds nothing produces no offenders and passes with a green
    // tick. The magnitude is the only thing that tells "clean" from "blind" —
    // see a-gate-must-not-pass-by-finding-nothing.
    expect(walk(SRC).length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
