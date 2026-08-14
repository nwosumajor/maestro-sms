// =============================================================================
// The pupil who closed their laptop never got a mark
// =============================================================================
// A CBT sitting expires "on read". But the only read that did it was the
// PUPIL's own — `getSitting` is scoped `studentId: p.userId` — so it fired when
// somebody came back to the tab, and never when they did not.
//
// A pupil who closed the laptop mid-paper left the row IN_PROGRESS for ever.
// There is no scheduled sweep for CBT (the jobs catalogue has none), so nothing
// else would close it. Two consequences, both quiet:
//
//   * the results page showed them still sitting an exam that ended weeks ago;
//   * `pushToGradebook` takes only SUBMITTED/EXPIRED, so their script was never
//     marked. The push reported how many scripts it wrote, not who it left out,
//     and the gradesheet was simply one candidate short.
//
// Their work is not lost: EXPIRED scores what was answered, exactly as it does
// for a pupil who runs out of time with the tab open. The difference is only
// whether anything ever closes the sitting.
//
// Finalising at BOTH staff doors — reading results and pushing to the gradebook
// — because a pupil's mark must not depend on which page a teacher opened first.
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../../src/cbt/cbt.service.ts"), "utf8");

describe("the expiry helper", () => {
  it("exists and takes the exam, not just an id", () => {
    // It needs durationMinutes AND endAt: the deadline is the EARLIER of the
    // sitting's own clock and the exam window closing.
    expect(SRC).toMatch(
      /private async expireOverdueSittings\(tx: TenantTx, p: Principal, exam: \{ id: string; durationMinutes: number; endAt: Date \}\)/,
    );
  });

  it("only touches sittings that are still IN_PROGRESS", () => {
    const fn = SRC.slice(SRC.indexOf("private async expireOverdueSittings"), SRC.indexOf("private timeUp("));
    expect(fn).toMatch(/status: "IN_PROGRESS"/);
  });

  it("checks each sitting's own clock before closing it", () => {
    // A sitting started late may still be running when the one beside it is
    // over. Closing the whole paper on one test would cut somebody off.
    const fn = SRC.slice(SRC.indexOf("private async expireOverdueSittings"), SRC.indexOf("private timeUp("));
    // The guard also skips a row with no start time: it cannot be timed, and
    // crashing a teacher's gradebook push on an impossible row helps nobody.
    expect(fn).toMatch(/if \(!s\.startedAt \|\| !this\.timeUp\(s\.startedAt, exam, now\)\) continue;/);
  });

  it("closes them as EXPIRED, which scores what was answered", () => {
    const fn = SRC.slice(SRC.indexOf("private async expireOverdueSittings"), SRC.indexOf("private timeUp("));
    expect(fn).toMatch(/this\.finalize\(tx, p, s\.id, "EXPIRED"\)/);
  });
});

describe("both staff doors close them", () => {
  it("reading the results does", () => {
    // Otherwise the page reports a pupil as still sitting an exam that ended.
    const fn = SRC.slice(SRC.indexOf("async examResults("), SRC.indexOf("async examResults(") + 1600);
    expect(fn).toMatch(/await this\.expireOverdueSittings\(tx, p, exam\)/);
  });

  it("pushing to the gradebook does", () => {
    // This is the one that costs a mark. The push takes SUBMITTED/EXPIRED only.
    const push = SRC.slice(SRC.indexOf("Only finished scripts are gradeable"));
    expect(push.slice(0, 400)).toMatch(/await this\.expireOverdueSittings\(tx, p, exam\)/);
  });

  it("expires BEFORE selecting the scripts to grade", () => {
    // Order matters: expiring after the query would change nothing this run.
    const push = SRC.slice(SRC.indexOf("Only finished scripts are gradeable"));
    expect(push.indexOf("expireOverdueSittings")).toBeLessThan(push.indexOf("cbtSitting.findMany"));
  });
});

describe("what is deliberately unchanged", () => {
  it("the pupil's own read still auto-expires", () => {
    // The original behaviour was right as far as it went; this adds to it.
    expect(SRC).toMatch(/Auto-expire on read so an abandoned tab still finalizes/);
  });

  it("answering after time is still refused and finalised", () => {
    expect(SRC).toMatch(/Time is up — the sitting has been submitted automatically/);
  });

  it("the deadline is still the EARLIER of the sitting clock and the exam window", () => {
    const fn = SRC.slice(SRC.indexOf("private timeUp("), SRC.indexOf("private timeUp(") + 400);
    expect(fn).toMatch(/Math\.min\(/);
    expect(fn).toMatch(/startedAt\.getTime\(\) \+ exam\.durationMinutes \* 60_000 \+ SUBMIT_GRACE_MS/);
    expect(fn).toMatch(/exam\.endAt\.getTime\(\) \+ SUBMIT_GRACE_MS/);
  });
});
