// =============================================================================
// A withdrawn consent leaves the cross-school arena
// =============================================================================
// The Ultimate arena is this platform's ONE deliberate tenant-boundary crossing.
// Entry needs two-tier consent: the school enrols, and the pupil's GUARDIAN
// grants consent. `setConsent(granted: false)` updated the consent row and did
// NOTHING to the arena — so a child whose guardian withdrew consent kept their
// handle, their school and their scores on a leaderboard visible to every other
// school in the competition, indefinitely.
//
// The integrity module already states the house rule for this: `runDetection`
// "re-checks consent so anything captured before a withdrawal is never
// analysed". The arena did not.
//
// Driven live, one finished entry:
//
//   consent GRANTED         1 on the board  ["MathWhiz"]
//   consent WITHDRAWN       0 on the board  []
//   consent GRANTED again   1 on the board  ["MathWhiz"]
//
// // A CROSS-SCHOOL READ CANNOT ASK. The arena is RLS-EXEMPT and deliberately
// holds no per-school data, so the leaderboard cannot consult each tenant's
// consent table — that is the whole two-halves design. The SCHOOL reaches its
// own pupil instead, through `ultimate_entry_link`, the only
// userId->participantId map and tenant-scoped, so a revocation can never touch
// another school's entry.
//
// // A NULLABLE MARKER, NOT A STATUS VALUE. `status` is the GAME state
// (ACTIVE/FINISHED). Overloading it would destroy a finish that re-consenting
// could then only guess back — which is why the third line above works.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SVC = readFileSync(join(__dirname, "../../src/game/ultimate.service.ts"), "utf8");
const SCHEMA = readFileSync(
  join(__dirname, "../../../../packages/db/prisma/schema/ultimate.prisma"),
  "utf8",
);

describe("withdrawing cross-school consent", () => {
  it("reaches the arena through the school's OWN map", () => {
    const setConsent = SVC.slice(SVC.indexOf("async setConsent"), SVC.indexOf("async enter"));
    expect(setConsent).toMatch(/ultimateEntryLink\.findMany/);
    expect(setConsent).toMatch(/ultimateParticipant\.updateMany/);
    // Scoped to THIS pupil — never a bare competition-wide write.
    expect(setConsent).toMatch(/where: \{ userId: input\.studentId \}/);
  });

  it("is reversible, and never touches the game state", () => {
    const setConsent = SVC.slice(SVC.indexOf("async setConsent"), SVC.indexOf("async enter"));
    expect(setConsent).toMatch(/withdrawnAt: input\.granted \? null : new Date\(\)/);
    // A withdrawal must not rewrite ACTIVE/FINISHED: re-consenting cannot guess
    // a finish back.
    expect(setConsent).not.toMatch(/data: \{[^}]*status:/);
  });

  it("is a separate column from the game state", () => {
    expect(SCHEMA).toMatch(/withdrawnAt DateTime\?/);
    expect(SCHEMA).toMatch(/enum UltimateParticipantStatus \{\s*ACTIVE\s*FINISHED\s*\}/);
  });

  it("every cross-school read excludes a withdrawn entry", () => {
    // Both of them. One filtered read and one unfiltered would put the child
    // back on a board through the other door.
    const reads = [...SVC.matchAll(/ultimateParticipant\.findMany\(\{[\s\S]{0,220}?\}\)/g)].map((m) => m[0]);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const r of reads) expect({ r, filtered: /withdrawnAt: null/.test(r) }).toEqual({ r, filtered: true });
  });
});
